use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;

// HOTFIX (2026-05-17, HanBin) — user-defined templates use custom
// frontmatter `type` values (e.g. "TEST4") that the strict enum
// rejected at deserialize time, breaking the 5.0.5a-migration "convert
// to template" flow. `Custom(String)` accepts any uppercase-coerced
// label; built-in variants stay so existing match sites (mod.rs default
// NOTE, suggestions.rs PAPER/THEO branches) keep compiling unchanged.
//
// Always stored in uppercase to match the file-on-disk convention
// (frontmatter writers + the frontend templateStore both emit upper).
fn deserialize_note_type<'de, D>(deserializer: D) -> Result<NoteType, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    Ok(NoteType::from_string(&s))
}

#[derive(Debug, Clone, PartialEq)]
pub enum NoteType {
    NOTE,
    MTG,
    PAPER,
    THEO,
    TASK,
    LIT,
    EVENT,
    CONTACT,
    CONTAINER,
    ADM,
    OFA,
    SEM,
    DATA,
    SETUP,
    SKETCH,
    /// User-defined template type (e.g. "TEST4", "PROJECT", etc.).
    /// Always uppercase-stored to match the on-disk convention.
    Custom(String),
}

impl NoteType {
    /// Parse a frontmatter `type:` string into a NoteType. Unknown values
    /// fall through to `Custom(uppercase)` so user-defined templates work.
    pub fn from_string(s: &str) -> Self {
        match s.to_uppercase().as_str() {
            "NOTE" => Self::NOTE,
            "MTG" => Self::MTG,
            "PAPER" => Self::PAPER,
            "THEO" => Self::THEO,
            "TASK" => Self::TASK,
            "LIT" => Self::LIT,
            "EVENT" => Self::EVENT,
            "CONTACT" => Self::CONTACT,
            "CONTAINER" => Self::CONTAINER,
            "ADM" => Self::ADM,
            "OFA" => Self::OFA,
            "SEM" => Self::SEM,
            "DATA" => Self::DATA,
            "SETUP" => Self::SETUP,
            "SKETCH" => Self::SKETCH,
            other => Self::Custom(other.to_string()),
        }
    }

    /// Round-trip string form — what gets written into the YAML
    /// frontmatter on disk. Built-in variants serialize to their name;
    /// Custom carries its own label verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::NOTE => "NOTE",
            Self::MTG => "MTG",
            Self::PAPER => "PAPER",
            Self::THEO => "THEO",
            Self::TASK => "TASK",
            Self::LIT => "LIT",
            Self::EVENT => "EVENT",
            Self::CONTACT => "CONTACT",
            Self::CONTAINER => "CONTAINER",
            Self::ADM => "ADM",
            Self::OFA => "OFA",
            Self::SEM => "SEM",
            Self::DATA => "DATA",
            Self::SETUP => "SETUP",
            Self::SKETCH => "SKETCH",
            Self::Custom(s) => s.as_str(),
        }
    }
}

impl Serialize for NoteType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Emit as a plain string (uppercase). Without this manual impl,
        // `Custom(String)` would serialize as `{"Custom":"TEST4"}`,
        // which yaml-writes into the file as a nested map and breaks
        // round-trip.
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NoteType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserialize_note_type(deserializer)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowState {
    Draft,
    InProgress,
    Review,
    Final,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceState {
    Unverified,
    Verified,
    Outdated,
    Disputed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub workflow: WorkflowState,
    pub confidence: ConfidenceState,
    pub maturity: u8, // 1-5
}

impl Default for State {
    fn default() -> Self {
        Self {
            workflow: WorkflowState::Draft,
            confidence: ConfidenceState::Unverified,
            maturity: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelationType {
    Supports,
    Refutes,
    Extends,
    Implements,
    DerivesFrom,
    PartOf,
    IsExampleOf,
    Causes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relation {
    pub relation_type: RelationType,
    pub target: String,
    pub strength: Option<f32>, // 0.0-1.0
}

// 11th hotfix (2026-05-18, HanBin) — Q1 cleanup: source/method/status
// removed. The official tag taxonomy is 4 facets: domain · who · org · ctx
// (matches TagInputSection on the frontend). Legacy notes with the dropped
// facets are auto-folded into `ctx` by `deserialize_tags` below to preserve
// user data while moving to the slimmer schema.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FacetedTags {
    #[serde(default)]
    pub domain: Vec<String>,
    #[serde(default)]
    pub who: Vec<String>,
    #[serde(default)]
    pub org: Vec<String>,
    #[serde(default)]
    pub ctx: Vec<String>,
}

// Custom deserializer for the `tags:` field.
//
// 11th hotfix (2026-05-18, HanBin) — now does two jobs that were previously
// either stubbed out or punted to a "next session" backlog:
//
//   1. **Legacy 7-facet → 4-facet fold (Q1).** If a note's `tags:` mapping
//      still carries source/method/status arrays from before the cleanup,
//      their items are appended to `ctx` (deduped) so no user data
//      disappears at next read. Subsequent saves emit only 4 facets,
//      naturally pruning the legacy keys from disk over time.
//
//   2. **Legacy flat array → faceted (Q2).** A `tags: ['foo','who/bar']`
//      style array (pre-faceted vaults) is bucketed by `<facet>/` prefix
//      into the matching facet; un-prefixed entries fall into `ctx`. This
//      lets old vaults open without manual migration.
fn deserialize_tags<'de, D>(deserializer: D) -> Result<FacetedTags, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    use serde_yaml::Value;

    let value = Value::deserialize(deserializer)?;

    fn push_unique(bucket: &mut Vec<String>, item: String) {
        if !item.is_empty() && !bucket.contains(&item) {
            bucket.push(item);
        }
    }

    match value {
        // New format: object with faceted fields. May carry legacy
        // source/method/status keys from before the Q1 cleanup — fold
        // those into ctx instead of dropping them.
        Value::Mapping(map) => {
            let mut tags = FacetedTags::default();
            for (k, v) in map {
                let key = k.as_str().unwrap_or("").to_string();
                let items: Vec<String> = match v {
                    Value::Sequence(seq) => seq
                        .into_iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .filter(|s| !s.is_empty())
                        .collect(),
                    Value::Null => Vec::new(),
                    _ => continue,
                };
                let target = match key.as_str() {
                    "domain" => &mut tags.domain,
                    "who" => &mut tags.who,
                    "org" => &mut tags.org,
                    // ctx + dropped facets all fold into ctx.
                    "ctx" | "source" | "method" | "status" => &mut tags.ctx,
                    _ => continue,
                };
                for item in items {
                    push_unique(target, item);
                }
            }
            Ok(tags)
        }
        // Legacy flat array. Bucket by `<facet>/` prefix; un-prefixed → ctx.
        Value::Sequence(seq) => {
            let mut tags = FacetedTags::default();
            for raw in seq {
                let Some(s) = raw.as_str() else { continue };
                let s = s.trim();
                if s.is_empty() {
                    continue;
                }
                if let Some(rest) = s.strip_prefix("domain/") {
                    push_unique(&mut tags.domain, rest.to_string());
                } else if let Some(rest) = s.strip_prefix("who/") {
                    push_unique(&mut tags.who, rest.to_string());
                } else if let Some(rest) = s.strip_prefix("org/") {
                    push_unique(&mut tags.org, rest.to_string());
                } else if let Some(rest) = s.strip_prefix("ctx/") {
                    push_unique(&mut tags.ctx, rest.to_string());
                } else if let Some(rest) = s.strip_prefix("source/")
                    .or_else(|| s.strip_prefix("method/"))
                    .or_else(|| s.strip_prefix("status/"))
                {
                    // Dropped facets in legacy array form → also fold to ctx.
                    push_unique(&mut tags.ctx, rest.to_string());
                } else {
                    push_unique(&mut tags.ctx, s.to_string());
                }
            }
            Ok(tags)
        }
        // Empty or null: return default
        Value::Null => Ok(FacetedTags::default()),
        _ => Err(Error::custom("Invalid tags format")),
    }
}

fn generate_note_id() -> String {
    use chrono::Local;
    let now = Local::now();
    now.format("%Y%m%d%H%M%S").to_string()
}

/// Base frontmatter structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frontmatter {
    #[serde(default = "generate_note_id")]
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub note_type: NoteType,
    pub created: String,
    pub modified: String,

    #[serde(default)]
    pub state: State,

    #[serde(default, deserialize_with = "deserialize_tags")]
    pub tags: FacetedTags,

    #[serde(default)]
    pub relations: Vec<Relation>,

    #[serde(default)]
    pub cssclasses: Vec<String>,

    // Type-specific fields (flatten into single struct for simplicity)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participants: Option<Vec<String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u16>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,

    // Allow extra fields for forward compatibility
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationError {
    pub path: String,
    pub message: String,
}
