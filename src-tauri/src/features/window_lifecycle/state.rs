//! Pure state machine for window lifecycle. See `mod.rs` for context.

/// The three valid window configurations Notology can be in.
///
/// Why no separate "Switching" state for the Main→Selector transition:
/// transitions are atomic. The side-effect ordering (hide M before
/// show S) is encoded in the [`SideEffect`] list returned by
/// [`transition`], not in a distinct state. Atomicity also means
/// concurrent events are serialized by the dispatcher, not by the
/// state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowMode {
    /// Startup; the app is still deciding whether to enter MainOnly
    /// (last vault is usable) or SelectorOnly (no usable vault).
    Splash,
    /// Selector visible, Main hidden.
    ///
    /// `return_to`:
    /// - `None` → user entered the selector at app start. Closing the
    ///   selector exits the app.
    /// - `Some(vault)` → user entered the selector via "보관소 변경".
    ///   Closing the selector cancels the switch and restores Main on
    ///   the previous vault.
    SelectorOnly { return_to: Option<String> },
    /// Main visible with a vault open. `hovers` lists the labels of all
    /// currently-open hover windows (always parented to Main).
    MainOnly { vault: String, hovers: Vec<String> },
    /// Terminal: cleanup running, no UI events change this.
    Exiting,
}

/// Events the dispatcher feeds into [`transition`]. Sources:
/// - `AppStart` from the Tauri setup hook
/// - `VaultSelected` from the selector React component (emit)
/// - `SwitchVaultRequested` from the main window's "보관소 변경" button
/// - `SelectorCloseRequested` / `MainCloseRequested` from the
///   `CloseRequested` window event
/// - `HoverOpen/CloseRequested` from frontend's hover commands
/// - `SystemShutdown` from the OS (Windows logoff, Android process kill)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// `last_vault.is_some()` iff a usable vault was found at startup.
    AppStart { last_vault: Option<String> },
    VaultSelected { vault: String },
    SwitchVaultRequested,
    SelectorCloseRequested,
    MainCloseRequested,
    HoverOpenRequested { label: String },
    HoverCloseRequested { label: String },
    SystemShutdown,
}

/// What the dispatcher should do, in order, after a transition. Always
/// terminates with `ExitApp` if the next state is `Exiting`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SideEffect {
    /// Flush all dirty editor buffers to disk before the window
    /// disappears. Issued whenever Main is leaving visibility.
    FlushSaves,
    /// Tell the sync engine to stop polling and drain its queue.
    /// Issued before app exit.
    TeardownSync,
    /// Close a specific hover window. Issued one per hover label.
    CloseHover { label: String },
    /// Create a new hover window parented to Main. The OS handles
    /// parent-close → child-close automatically once `parent_label`
    /// is set, so the dispatcher should not need to manually close
    /// hovers on app exit (but does so defensively for clarity).
    CreateHoverWithParent { label: String, parent: String },
    /// `WebviewWindow::hide` on Main. Use hide, not close, so the
    /// React state survives a "보관소 변경" round-trip.
    HideMain,
    /// `WebviewWindow::show` on Main.
    ShowMain,
    /// Open the selector window. Includes the `return_to` value so the
    /// selector knows whether its close should exit the app or
    /// restore Main.
    ShowSelector { return_to: Option<String> },
    /// `WebviewWindow::close` on the selector. Idempotent for safety
    /// (selector may already be gone).
    CloseSelector,
    /// Terminal. The dispatcher should call `app.exit(0)` after
    /// running all preceding effects.
    ExitApp,
}

/// The pure transition function.
///
/// Every `(mode, event)` pair has a defined behavior. Unsupported
/// pairs (e.g. `HoverOpen` while in `SelectorOnly`) intentionally
/// return the input mode unchanged with no side effects — this models
/// "ignore stale events" which is safer than panicking.
pub fn transition(mode: &WindowMode, event: Event) -> (WindowMode, Vec<SideEffect>) {
    use Event::*;
    use SideEffect::*;
    use WindowMode::*;

    match (mode, event) {
        // ── Splash → entry mode based on vault availability ──
        (Splash, AppStart { last_vault: Some(v) }) => (
            MainOnly { vault: v, hovers: vec![] },
            vec![ShowMain],
        ),
        (Splash, AppStart { last_vault: None }) => (
            SelectorOnly { return_to: None },
            vec![ShowSelector { return_to: None }],
        ),

        // ── Selector: vault picked → enter Main ──
        (SelectorOnly { .. }, VaultSelected { vault }) => (
            MainOnly { vault, hovers: vec![] },
            vec![CloseSelector, ShowMain],
        ),

        // ── Selector: close → either exit or return to Main ──
        (SelectorOnly { return_to: None }, SelectorCloseRequested) => (
            Exiting,
            vec![CloseSelector, TeardownSync, ExitApp],
        ),
        (SelectorOnly { return_to: Some(v) }, SelectorCloseRequested) => (
            MainOnly { vault: v.clone(), hovers: vec![] },
            vec![CloseSelector, ShowMain],
        ),

        // ── Main: "보관소 변경" → hide Main, close hovers, show S ──
        (MainOnly { vault, hovers }, SwitchVaultRequested) => {
            let mut effects: Vec<SideEffect> = vec![FlushSaves];
            for h in hovers {
                effects.push(CloseHover { label: h.clone() });
            }
            effects.push(HideMain);
            effects.push(ShowSelector {
                return_to: Some(vault.clone()),
            });
            (
                SelectorOnly { return_to: Some(vault.clone()) },
                effects,
            )
        }

        // ── Main: close → flush, teardown, exit (parent_label closes hovers automatically) ──
        (MainOnly { hovers, .. }, MainCloseRequested) => {
            let mut effects: Vec<SideEffect> = vec![FlushSaves];
            // Defensive: close hovers ourselves too. parent_label is supposed
            // to chain-close them, but we issue explicit closes so dirty
            // hover state can't leak past app exit even if a hover lost its
            // parent association at runtime.
            for h in hovers {
                effects.push(CloseHover { label: h.clone() });
            }
            effects.push(CloseSelector); // race-safe: ignore if absent
            effects.push(TeardownSync);
            effects.push(ExitApp);
            (Exiting, effects)
        }

        // ── Main: hover open/close (state-only; parent stays Main) ──
        (MainOnly { vault, hovers }, HoverOpenRequested { label }) => {
            // Dedupe: if already open, just focus (no state change).
            if hovers.contains(&label) {
                return (mode.clone(), vec![]);
            }
            let mut next = hovers.clone();
            next.push(label.clone());
            (
                MainOnly {
                    vault: vault.clone(),
                    hovers: next,
                },
                vec![CreateHoverWithParent {
                    label,
                    parent: "main".to_string(),
                }],
            )
        }
        (MainOnly { vault, hovers }, HoverCloseRequested { label }) => {
            // Idempotency guard (2026-05-18, HanBin) — breaks the 50k/sec
            // dispatcher loop seen during v4.3/4.4 testing. Mechanism:
            //   1. User closes hover → OS fires `CloseRequested` → lib.rs
            //      dispatches HoverCloseRequested. We remove the label
            //      from `hovers` and emit `CloseHover { label }`.
            //   2. The CloseHover effect calls `w.close()`. Tauri's close
            //      path on an already-closing window can re-emit
            //      `CloseRequested`, which lib.rs translates back into
            //      another HoverCloseRequested for the same label.
            //   3. By now `hovers` no longer contains the label. Without
            //      this guard the transition would still emit
            //      `CloseHover { label }`, the effect would call
            //      `w.close()` yet again, the cycle repeats — drowning
            //      logs and pegging a core.
            // Skipping both state change AND effect when the label is
            // already gone makes the second-and-subsequent dispatches
            // pure no-ops, so the OS-level close completes naturally
            // and the cycle terminates.
            if !hovers.contains(&label) {
                return (mode.clone(), vec![]);
            }
            let next: Vec<String> = hovers.iter().filter(|h| **h != label).cloned().collect();
            (
                MainOnly {
                    vault: vault.clone(),
                    hovers: next,
                },
                vec![CloseHover { label }],
            )
        }

        // ── System shutdown: terminal from any non-Exiting state ──
        (Splash, SystemShutdown)
        | (SelectorOnly { .. }, SystemShutdown)
        | (MainOnly { .. }, SystemShutdown) => (
            Exiting,
            vec![FlushSaves, TeardownSync, ExitApp],
        ),

        // ── Exiting: swallow everything ──
        (Exiting, _) => (Exiting, vec![]),

        // ── Anything else: ignore (stale or misrouted event) ──
        _ => (mode.clone(), vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: assert that running `events` from `start` reaches `expect_mode`
    // and emits effects matching `expect_effects` (in order).
    fn step(start: WindowMode, event: Event) -> (WindowMode, Vec<SideEffect>) {
        transition(&start, event)
    }

    // ── A. 초기 진입 ─────────────────────────────────────

    #[test]
    fn a1_a2_no_last_vault_enters_selector_at_startup() {
        let (m, fx) = step(WindowMode::Splash, Event::AppStart { last_vault: None });
        assert_eq!(m, WindowMode::SelectorOnly { return_to: None });
        assert_eq!(fx, vec![SideEffect::ShowSelector { return_to: None }]);
    }

    #[test]
    fn a3_a5_last_vault_enters_main_at_startup() {
        let (m, fx) = step(
            WindowMode::Splash,
            Event::AppStart { last_vault: Some("v1".into()) },
        );
        assert_eq!(
            m,
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] }
        );
        assert_eq!(fx, vec![SideEffect::ShowMain]);
    }

    #[test]
    fn a4_unusable_last_vault_caller_passes_none() {
        // The dispatcher (not this state machine) is responsible for
        // validating the local vault dir before calling AppStart. A4 is
        // its responsibility — here we just verify the no-vault path.
        let (m, _) = step(WindowMode::Splash, Event::AppStart { last_vault: None });
        assert!(matches!(m, WindowMode::SelectorOnly { return_to: None }));
    }

    // ── B. 보관소 변경 흐름 ──────────────────────────────

    #[test]
    fn b1_switch_from_main_closes_hovers_hides_main_shows_selector() {
        let (m, fx) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into(), "h2".into()],
            },
            Event::SwitchVaultRequested,
        );
        assert_eq!(m, WindowMode::SelectorOnly { return_to: Some("v1".into()) });
        // Side-effect ordering matters: flush → close hovers → hide main → show selector
        assert_eq!(fx[0], SideEffect::FlushSaves);
        assert_eq!(fx[1], SideEffect::CloseHover { label: "h1".into() });
        assert_eq!(fx[2], SideEffect::CloseHover { label: "h2".into() });
        assert_eq!(fx[3], SideEffect::HideMain);
        assert_eq!(fx[4], SideEffect::ShowSelector { return_to: Some("v1".into()) });
    }

    #[test]
    fn b2_select_same_vault_returns_to_main_with_that_vault() {
        let (m, fx) = step(
            WindowMode::SelectorOnly { return_to: Some("v1".into()) },
            Event::VaultSelected { vault: "v1".into() },
        );
        assert_eq!(m, WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] });
        assert_eq!(fx, vec![SideEffect::CloseSelector, SideEffect::ShowMain]);
    }

    #[test]
    fn b3_select_different_vault_swaps_vault() {
        let (m, _) = step(
            WindowMode::SelectorOnly { return_to: Some("v1".into()) },
            Event::VaultSelected { vault: "v2".into() },
        );
        assert_eq!(m, WindowMode::MainOnly { vault: "v2".into(), hovers: vec![] });
    }

    #[test]
    fn b6_selector_close_with_return_to_restores_main() {
        let (m, fx) = step(
            WindowMode::SelectorOnly { return_to: Some("v1".into()) },
            Event::SelectorCloseRequested,
        );
        assert_eq!(m, WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] });
        assert_eq!(fx, vec![SideEffect::CloseSelector, SideEffect::ShowMain]);
    }

    #[test]
    fn b7_switch_always_emits_flushsaves_first() {
        let (_, fx) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::SwitchVaultRequested,
        );
        assert_eq!(fx.first(), Some(&SideEffect::FlushSaves));
    }

    // ── C. Selector 단독 종료 ─────────────────────────────

    #[test]
    fn c1_selector_close_with_no_return_exits_app() {
        let (m, fx) = step(
            WindowMode::SelectorOnly { return_to: None },
            Event::SelectorCloseRequested,
        );
        assert_eq!(m, WindowMode::Exiting);
        assert_eq!(
            fx,
            vec![SideEffect::CloseSelector, SideEffect::TeardownSync, SideEffect::ExitApp]
        );
    }

    #[test]
    fn c2_selector_close_with_return_does_not_exit() {
        let (m, fx) = step(
            WindowMode::SelectorOnly { return_to: Some("v1".into()) },
            Event::SelectorCloseRequested,
        );
        assert!(!fx.contains(&SideEffect::ExitApp));
        assert!(matches!(m, WindowMode::MainOnly { .. }));
    }

    // ── D. Hover lifecycle ───────────────────────────────

    #[test]
    fn d1_d2_hover_open_appends_with_parent_main() {
        let (m, fx) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::HoverOpenRequested { label: "h1".into() },
        );
        assert_eq!(
            m,
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec!["h1".into()] }
        );
        assert_eq!(
            fx,
            vec![SideEffect::CreateHoverWithParent {
                label: "h1".into(),
                parent: "main".into(),
            }]
        );
    }

    #[test]
    fn d3_hover_open_dedupes_when_label_exists() {
        let (m, fx) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into()],
            },
            Event::HoverOpenRequested { label: "h1".into() },
        );
        assert_eq!(
            m,
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec!["h1".into()] }
        );
        assert!(fx.is_empty(), "no creation effect when label exists");
    }

    #[test]
    fn d4_distinct_labels_accumulate() {
        let (m, _) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into()],
            },
            Event::HoverOpenRequested { label: "h2".into() },
        );
        assert_eq!(
            m,
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into(), "h2".into()]
            }
        );
    }

    #[test]
    fn d5_x_hover_close_is_noop_when_label_already_gone() {
        // Regression for the HoverCloseRequested infinite-loop bug
        // (2026-05-18): a second close event for the same label (which
        // arrives when Tauri re-emits CloseRequested as a side effect of
        // our own w.close()) must NOT re-emit CloseHover, otherwise the
        // dispatcher spins at thousands of events per second.
        let (m, fx) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h2".into()],
            },
            Event::HoverCloseRequested { label: "h1".into() },
        );
        assert_eq!(
            m,
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec!["h2".into()] },
            "state must not change when label isn't in hovers"
        );
        assert!(fx.is_empty(), "no CloseHover effect when label already gone");
    }

    #[test]
    fn d5_hover_close_removes_one_keeps_others() {
        let (m, fx) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into(), "h2".into()],
            },
            Event::HoverCloseRequested { label: "h1".into() },
        );
        assert_eq!(
            m,
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec!["h2".into()] }
        );
        assert_eq!(fx, vec![SideEffect::CloseHover { label: "h1".into() }]);
    }

    #[test]
    fn d8_switch_from_main_with_hovers_closes_them_all() {
        let (m, fx) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into(), "h2".into(), "h3".into()],
            },
            Event::SwitchVaultRequested,
        );
        assert!(matches!(m, WindowMode::SelectorOnly { .. }));
        let close_count = fx
            .iter()
            .filter(|e| matches!(e, SideEffect::CloseHover { .. }))
            .count();
        assert_eq!(close_count, 3);
    }

    // ── E. 메인 종료 ──────────────────────────────────────

    #[test]
    fn e1_main_close_clean_exits() {
        let (m, fx) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::MainCloseRequested,
        );
        assert_eq!(m, WindowMode::Exiting);
        assert!(fx.contains(&SideEffect::FlushSaves));
        assert!(fx.contains(&SideEffect::TeardownSync));
        assert_eq!(fx.last(), Some(&SideEffect::ExitApp));
    }

    #[test]
    fn e2_main_close_flushes_before_teardown() {
        let (_, fx) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::MainCloseRequested,
        );
        let i_flush = fx.iter().position(|e| e == &SideEffect::FlushSaves).unwrap();
        let i_teardown = fx.iter().position(|e| e == &SideEffect::TeardownSync).unwrap();
        assert!(i_flush < i_teardown, "flush must precede teardown");
    }

    #[test]
    fn e3_main_close_closes_hovers_and_selector_defensively() {
        let (_, fx) = step(
            WindowMode::MainOnly {
                vault: "v1".into(),
                hovers: vec!["h1".into()],
            },
            Event::MainCloseRequested,
        );
        assert!(fx.contains(&SideEffect::CloseHover { label: "h1".into() }));
        assert!(fx.contains(&SideEffect::CloseSelector));
    }

    // ── F. Race conditions ───────────────────────────────

    #[test]
    fn f1_main_close_during_switch_wins_app_exits() {
        // Step 1: switch starts.
        let (after_switch, _) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::SwitchVaultRequested,
        );
        // Step 2: from the resulting SelectorOnly{Some(v1)}, a MainClose
        // event can't logically arrive (Main is already hidden), so it's
        // ignored. The legitimate "double-action" is SelectorClose,
        // which restores Main per b6. App exit in this case comes from
        // the user then closing Main again.
        let (after_mclose, fx) = step(after_switch, Event::MainCloseRequested);
        // Ignored, since main is no longer the active window per mode.
        assert!(matches!(after_mclose, WindowMode::SelectorOnly { .. }));
        assert!(fx.is_empty(), "stale MainClose during SelectorOnly is ignored");
    }

    #[test]
    fn f2_repeated_switch_is_idempotent_in_selector_only() {
        let (after_first, _) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::SwitchVaultRequested,
        );
        // Mode is SelectorOnly{Some(v1)}. A second SwitchVaultRequested
        // should be ignored (no second selector spawned).
        let (after_second, fx) = step(after_first.clone(), Event::SwitchVaultRequested);
        assert_eq!(after_first, after_second);
        assert!(fx.is_empty());
    }

    #[test]
    fn f3_vault_selected_during_selector_only_wins_over_pending_close() {
        // The dispatcher serializes events, so this just checks both
        // events succeed independently. The "winner" depends on which
        // arrives first.
        let (m, _) = step(
            WindowMode::SelectorOnly { return_to: Some("v1".into()) },
            Event::VaultSelected { vault: "v2".into() },
        );
        assert_eq!(m, WindowMode::MainOnly { vault: "v2".into(), hovers: vec![] });
        // From here, SelectorCloseRequested is stale and should be ignored:
        let (m2, fx) = step(m, Event::SelectorCloseRequested);
        assert!(matches!(m2, WindowMode::MainOnly { .. }));
        assert!(fx.is_empty());
    }

    #[test]
    fn f4_concurrent_open_of_same_hover_dedupes() {
        // Same as D3 — behavioral guarantee: dispatcher can fire both
        // events sequentially and the second is a no-op.
        let m1 = WindowMode::MainOnly {
            vault: "v1".into(),
            hovers: vec![],
        };
        let (m2, _) = step(m1, Event::HoverOpenRequested { label: "h1".into() });
        let (m3, fx3) = step(m2.clone(), Event::HoverOpenRequested { label: "h1".into() });
        assert_eq!(m2, m3);
        assert!(fx3.is_empty());
    }

    #[test]
    fn f7_hover_open_in_selector_only_is_ignored() {
        let (m, fx) = step(
            WindowMode::SelectorOnly { return_to: None },
            Event::HoverOpenRequested { label: "h1".into() },
        );
        assert!(matches!(m, WindowMode::SelectorOnly { return_to: None }));
        assert!(fx.is_empty(), "hover open invalid outside MainOnly");
    }

    // ── System shutdown ──────────────────────────────────

    #[test]
    fn shutdown_from_main_emits_flush_teardown_exit() {
        let (m, fx) = step(
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] },
            Event::SystemShutdown,
        );
        assert_eq!(m, WindowMode::Exiting);
        assert_eq!(
            fx,
            vec![SideEffect::FlushSaves, SideEffect::TeardownSync, SideEffect::ExitApp]
        );
    }

    #[test]
    fn shutdown_from_selector_also_exits() {
        let (m, fx) = step(
            WindowMode::SelectorOnly { return_to: None },
            Event::SystemShutdown,
        );
        assert_eq!(m, WindowMode::Exiting);
        assert!(fx.contains(&SideEffect::ExitApp));
    }

    #[test]
    fn exiting_swallows_all_events() {
        for ev in [
            Event::AppStart { last_vault: None },
            Event::VaultSelected { vault: "v".into() },
            Event::SwitchVaultRequested,
            Event::SelectorCloseRequested,
            Event::MainCloseRequested,
            Event::HoverOpenRequested { label: "h".into() },
            Event::HoverCloseRequested { label: "h".into() },
            Event::SystemShutdown,
        ] {
            let (m, fx) = step(WindowMode::Exiting, ev);
            assert_eq!(m, WindowMode::Exiting);
            assert!(fx.is_empty(), "Exiting must absorb all events without effect");
        }
    }

    // ── Full-flow scenarios ──────────────────────────────

    #[test]
    fn full_flow_first_run_then_select_vault_then_exit() {
        // A1 → select → E1
        let (m, _) = step(WindowMode::Splash, Event::AppStart { last_vault: None });
        let (m, _) = step(m, Event::VaultSelected { vault: "v1".into() });
        assert!(matches!(m, WindowMode::MainOnly { .. }));
        let (m, fx) = step(m, Event::MainCloseRequested);
        assert_eq!(m, WindowMode::Exiting);
        assert!(fx.contains(&SideEffect::ExitApp));
    }

    #[test]
    fn full_flow_switch_vault_then_cancel() {
        // A3 → B1 → B6 (cancel back to original vault)
        let (m, _) = step(
            WindowMode::Splash,
            Event::AppStart { last_vault: Some("v1".into()) },
        );
        let (m, _) = step(m, Event::SwitchVaultRequested);
        assert_eq!(m, WindowMode::SelectorOnly { return_to: Some("v1".into()) });
        let (m, _) = step(m, Event::SelectorCloseRequested);
        assert_eq!(m, WindowMode::MainOnly { vault: "v1".into(), hovers: vec![] });
    }

    #[test]
    fn full_flow_switch_to_different_vault() {
        let (m, _) = step(
            WindowMode::Splash,
            Event::AppStart { last_vault: Some("v1".into()) },
        );
        let (m, _) = step(m, Event::SwitchVaultRequested);
        let (m, _) = step(m, Event::VaultSelected { vault: "v2".into() });
        assert_eq!(m, WindowMode::MainOnly { vault: "v2".into(), hovers: vec![] });
    }

    #[test]
    fn full_flow_hover_open_close_close_main() {
        let (m, _) = step(
            WindowMode::Splash,
            Event::AppStart { last_vault: Some("v1".into()) },
        );
        let (m, _) = step(m, Event::HoverOpenRequested { label: "h1".into() });
        let (m, _) = step(m, Event::HoverOpenRequested { label: "h2".into() });
        let (m, _) = step(m, Event::HoverCloseRequested { label: "h1".into() });
        assert_eq!(
            m,
            WindowMode::MainOnly { vault: "v1".into(), hovers: vec!["h2".into()] }
        );
        let (m, fx) = step(m, Event::MainCloseRequested);
        assert_eq!(m, WindowMode::Exiting);
        // h2 must be closed before exit
        assert!(fx.contains(&SideEffect::CloseHover { label: "h2".into() }));
    }
}
