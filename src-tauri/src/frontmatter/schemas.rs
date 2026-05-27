use lazy_static::lazy_static;
use serde_json::json;

lazy_static! {
    pub static ref BASE_SCHEMA: serde_json::Value = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Base Note Schema",
        "type": "object",
        "required": ["id", "title", "type", "created", "modified", "state"],
        "properties": {
            "id": {
                "type": "string",
                "pattern": "^[0-9]{14}([0-9]{3})?$",
                "description": "14 or 17-digit timestamp ID (YYYYMMDDHHMMSS with optional milliseconds)"
            },
            "title": {
                "type": "string",
                "minLength": 1,
                "description": "Note title"
            },
            "type": {
                // HOTFIX (2026-05-17, HanBin) — was an `enum: [...]` whitelist
                // of 15 built-in types; that rejected user-defined template
                // types (e.g. "TEST4") at JSON-schema validation time and
                // broke the 5.0.5a-migration "convert to template" flow.
                // Now any non-empty uppercase string is accepted; the Rust
                // NoteType enum's Custom(String) variant catches unknowns.
                "type": "string",
                "pattern": "^[A-Z][A-Z0-9_]*$",
                "description": "Note type — built-in (NOTE/MTG/PAPER/THEO/TASK/LIT/EVENT/CONTACT/CONTAINER/ADM/OFA/SEM/DATA/SETUP/SKETCH) or a user-defined template key"
            },
            "created": {
                "type": "string",
                "description": "Creation timestamp (ISO 8601 or YYYY-MM-DDTHH:MM:SS)"
            },
            "modified": {
                "type": "string",
                "description": "Last modified timestamp (ISO 8601 or YYYY-MM-DDTHH:MM:SS)"
            },
            "state": {
                "type": "object",
                "required": ["workflow", "confidence", "maturity"],
                "properties": {
                    "workflow": {
                        "type": "string",
                        "enum": ["draft", "in-progress", "review", "final", "archived"]
                    },
                    "confidence": {
                        "type": "string",
                        "enum": ["unverified", "verified", "outdated", "disputed"]
                    },
                    "maturity": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5
                    }
                }
            },
            "tags": {
                "type": "object",
                "properties": {
                    "domain": { "type": "array", "items": { "type": "string" } },
                    "who": { "type": "array", "items": { "type": "string" } },
                    "org": { "type": "array", "items": { "type": "string" } },
                    "ctx": { "type": "array", "items": { "type": "string" } },
                    "source": { "type": "array", "items": { "type": "string" } },
                    "method": { "type": "array", "items": { "type": "string" } },
                    "status": { "type": "array", "items": { "type": "string" } }
                }
            },
            "relations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["relation_type", "target"],
                    "properties": {
                        "relation_type": {
                            "type": "string",
                            "enum": ["supports", "refutes", "extends", "implements", "derives-from", "part-of", "is-example-of", "causes"]
                        },
                        "target": { "type": "string" },
                        "strength": {
                            "type": ["number", "null"],
                            "minimum": 0.0,
                            "maximum": 1.0
                        }
                    }
                }
            },
            "cssclasses": {
                "type": "array",
                "items": { "type": "string" }
            }
        }
    });

    pub static ref MTG_SCHEMA: serde_json::Value = {
        let mut schema = BASE_SCHEMA.clone();
        if let Some(obj) = schema.as_object_mut() {
            if let Some(props) = obj.get_mut("properties") {
                if let Some(props_obj) = props.as_object_mut() {
                    props_obj.insert("participants".to_string(), json!({
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Meeting participants"
                    }));
                    props_obj.insert("date".to_string(), json!({
                        "type": "string",
                        "description": "Meeting date"
                    }));
                }
            }
        }
        schema
    };

    pub static ref PAPER_SCHEMA: serde_json::Value = {
        let mut schema = BASE_SCHEMA.clone();
        if let Some(obj) = schema.as_object_mut() {
            if let Some(props) = obj.get_mut("properties") {
                if let Some(props_obj) = props.as_object_mut() {
                    props_obj.insert("authors".to_string(), json!({
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Paper authors"
                    }));
                    props_obj.insert("venue".to_string(), json!({
                        "type": "string",
                        "description": "Publication venue"
                    }));
                    props_obj.insert("year".to_string(), json!({
                        "type": "integer",
                        "minimum": 1900,
                        "maximum": 2100,
                        "description": "Publication year"
                    }));
                    props_obj.insert("doi".to_string(), json!({
                        "type": "string",
                        "description": "DOI identifier"
                    }));
                    props_obj.insert("url".to_string(), json!({
                        "type": "string",
                        "description": "Paper URL"
                    }));
                }
            }
        }
        schema
    };

    pub static ref TASK_SCHEMA: serde_json::Value = {
        let mut schema = BASE_SCHEMA.clone();
        if let Some(obj) = schema.as_object_mut() {
            if let Some(props) = obj.get_mut("properties") {
                if let Some(props_obj) = props.as_object_mut() {
                    props_obj.insert("due".to_string(), json!({
                        "type": "string",
                        "description": "Task due date"
                    }));
                    props_obj.insert("priority".to_string(), json!({
                        "type": "string",
                        "enum": ["low", "medium", "high", "urgent"],
                        "description": "Task priority"
                    }));
                    props_obj.insert("assignee".to_string(), json!({
                        "type": "string",
                        "description": "Person assigned to task"
                    }));
                }
            }
        }
        schema
    };

    pub static ref CONTACT_SCHEMA: serde_json::Value = {
        let mut schema = BASE_SCHEMA.clone();
        if let Some(obj) = schema.as_object_mut() {
            if let Some(props) = obj.get_mut("properties") {
                if let Some(props_obj) = props.as_object_mut() {
                    props_obj.insert("email".to_string(), json!({
                        "type": "string",
                        "description": "Contact email"
                    }));
                    props_obj.insert("phone".to_string(), json!({
                        "type": "string",
                        "description": "Phone number"
                    }));
                    props_obj.insert("organization".to_string(), json!({
                        "type": "string",
                        "description": "Organization name"
                    }));
                    props_obj.insert("role".to_string(), json!({
                        "type": "string",
                        "description": "Role or position"
                    }));
                }
            }
        }
        schema
    };
}

pub fn get_schema_for_type(note_type: &str) -> &'static serde_json::Value {
    match note_type {
        "MTG" => &MTG_SCHEMA,
        "PAPER" => &PAPER_SCHEMA,
        "TASK" => &TASK_SCHEMA,
        "CONTACT" => &CONTACT_SCHEMA,
        _ => &BASE_SCHEMA,
    }
}
