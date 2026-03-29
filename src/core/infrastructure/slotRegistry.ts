/**
 * SlotRegistry — Core UI에 빈 슬롯을 두고, Feature가 컴포넌트를 주입.
 *
 * Core 컴포넌트에 <Slot name="xxx" /> 를 한 번 배치하면,
 * 이후 Feature가 SlotRegistry.register('xxx', Component) 로 컴포넌트를 꽂는다.
 * Feature를 제거하면 슬롯이 비어있을 뿐 Core는 영향 없음.
 *
 * 이 파일은 한 번 작성 후 수정하지 않는다.
 */

import React, { useSyncExternalStore, type ComponentType } from 'react';

interface SlotEntry {
  component: ComponentType<any>;
  props?: Record<string, any>;
  order: number;
}

// Stable snapshot references per slot (useSyncExternalStore requires referential equality)
const slots = new Map<string, SlotEntry[]>();
const snapshots = new Map<string, SlotEntry[]>();
const listeners = new Set<() => void>();

const EMPTY: SlotEntry[] = [];

function notify() {
  // Update snapshots for changed slots
  for (const [name, entries] of slots) {
    snapshots.set(name, [...entries]);
  }
  listeners.forEach(fn => fn());
}

export const SlotRegistry = {
  register(slotName: string, component: ComponentType<any>, props?: Record<string, any>, order = 0): () => void {
    if (!slots.has(slotName)) {
      slots.set(slotName, []);
    }
    const entry: SlotEntry = { component, props, order };
    slots.get(slotName)!.push(entry);
    slots.get(slotName)!.sort((a, b) => a.order - b.order);
    notify();

    return () => {
      const entries = slots.get(slotName);
      if (entries) {
        const idx = entries.indexOf(entry);
        if (idx !== -1) entries.splice(idx, 1);
        notify();
      }
    };
  },

  /** Return stable snapshot (same reference until notify) */
  _getSnapshot(slotName: string): SlotEntry[] {
    return snapshots.get(slotName) || EMPTY;
  },

  _subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/**
 * <Slot name="xxx" /> — Core UI 컴포넌트에 배치.
 */
export function Slot({ name, ...extraProps }: { name: string } & Record<string, any>) {
  const entries = useSyncExternalStore(
    SlotRegistry._subscribe,
    () => SlotRegistry._getSnapshot(name),
  );

  if (entries.length === 0) return null;

  return React.createElement(
    React.Fragment,
    null,
    entries.map((entry, i) =>
      React.createElement(entry.component, { key: `${name}-${i}`, ...entry.props, ...extraProps })
    ),
  );
}
