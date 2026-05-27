#![allow(dead_code)]

use super::types::{Frontmatter, RelationType, WorkflowState, ConfidenceState};
use std::collections::HashMap;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    pub suggestion_type: SuggestionType,
    pub confidence: f32,
    pub description: String,
    pub action: SuggestionAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SuggestionType {
    RelationSuggestion,
    TagSuggestion,
    StateTransition,
    QualityImprovement,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SuggestionAction {
    AddRelation {
        relation_type: RelationType,
        target: String,
        strength: f32,
    },
    AddTag {
        facet: String,
        tag: String,
    },
    UpdateState {
        field: String,
        value: String,
    },
    AddField {
        field: String,
        value: String,
    },
}

pub struct SuggestionEngine;

impl SuggestionEngine {
    /// Generate suggestions for a frontmatter
    pub fn generate_suggestions(
        frontmatter: &Frontmatter,
        all_notes: &[Frontmatter],
    ) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();

        // State transition suggestions
        suggestions.extend(Self::suggest_state_transitions(frontmatter));

        // Tag co-occurrence suggestions
        suggestions.extend(Self::suggest_tags_from_cooccurrence(frontmatter, all_notes));

        // Relation suggestions based on content patterns
        suggestions.extend(Self::suggest_relations_from_patterns(frontmatter, all_notes));

        // Quality improvement suggestions
        suggestions.extend(Self::suggest_quality_improvements(frontmatter));

        // Sort by confidence
        suggestions.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());

        suggestions
    }

    /// Suggest state transitions based on current state
    fn suggest_state_transitions(frontmatter: &Frontmatter) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();

        // Workflow transitions
        match frontmatter.state.workflow {
            WorkflowState::Draft => {
                if frontmatter.state.maturity >= 2 {
                    suggestions.push(Suggestion {
                        suggestion_type: SuggestionType::StateTransition,
                        confidence: 0.8,
                        description: "이 노트는 진행 중 상태로 전환할 준비가 되었습니다.".to_string(),
                        action: SuggestionAction::UpdateState {
                            field: "workflow".to_string(),
                            value: "in-progress".to_string(),
                        },
                    });
                }
            }
            WorkflowState::InProgress => {
                if frontmatter.state.maturity >= 4 && frontmatter.state.confidence == ConfidenceState::Verified {
                    suggestions.push(Suggestion {
                        suggestion_type: SuggestionType::StateTransition,
                        confidence: 0.85,
                        description: "성숙도와 신뢰도가 높아 검토 단계로 이동할 수 있습니다.".to_string(),
                        action: SuggestionAction::UpdateState {
                            field: "workflow".to_string(),
                            value: "review".to_string(),
                        },
                    });
                }
            }
            WorkflowState::Review => {
                if frontmatter.state.maturity == 5 {
                    suggestions.push(Suggestion {
                        suggestion_type: SuggestionType::StateTransition,
                        confidence: 0.9,
                        description: "최고 성숙도에 도달했습니다. 완료 상태로 전환하세요.".to_string(),
                        action: SuggestionAction::UpdateState {
                            field: "workflow".to_string(),
                            value: "final".to_string(),
                        },
                    });
                }
            }
            _ => {}
        }

        // Confidence transitions
        if frontmatter.state.confidence == ConfidenceState::Unverified
            && frontmatter.state.maturity >= 3
            && !frontmatter.relations.is_empty() {
            suggestions.push(Suggestion {
                suggestion_type: SuggestionType::StateTransition,
                confidence: 0.7,
                description: "관계가 설정되고 성숙도가 높아졌습니다. 검증 상태로 업그레이드하세요.".to_string(),
                action: SuggestionAction::UpdateState {
                    field: "confidence".to_string(),
                    value: "verified".to_string(),
                },
            });
        }

        suggestions
    }

    /// Suggest tags based on co-occurrence analysis
    fn suggest_tags_from_cooccurrence(
        frontmatter: &Frontmatter,
        all_notes: &[Frontmatter],
    ) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();

        // Get current tags
        let current_tags = Self::get_all_tags(frontmatter);

        // Count tag co-occurrences
        let mut cooccurrence: HashMap<String, HashMap<String, usize>> = HashMap::new();

        for note in all_notes {
            let note_tags = Self::get_all_tags(note);

            // For each pair of tags in this note
            for tag1 in &note_tags {
                for tag2 in &note_tags {
                    if tag1 != tag2 {
                        *cooccurrence
                            .entry(tag1.clone())
                            .or_insert_with(HashMap::new)
                            .entry(tag2.clone())
                            .or_insert(0) += 1;
                    }
                }
            }
        }

        // Find tags that frequently co-occur with current tags
        let mut tag_scores: HashMap<String, usize> = HashMap::new();
        for current_tag in &current_tags {
            if let Some(cooccur_map) = cooccurrence.get(current_tag) {
                for (other_tag, count) in cooccur_map {
                    if !current_tags.contains(other_tag) {
                        *tag_scores.entry(other_tag.clone()).or_insert(0) += count;
                    }
                }
            }
        }

        // Convert to suggestions (top 3)
        let mut sorted_tags: Vec<_> = tag_scores.into_iter().collect();
        sorted_tags.sort_by(|a, b| b.1.cmp(&a.1));

        for (tag, score) in sorted_tags.iter().take(3) {
            let confidence = ((*score as f32) / (all_notes.len() as f32)).min(0.9);

            // Determine facet from tag prefix
            let facet = tag.split('/').next().unwrap_or("domain").to_string();

            suggestions.push(Suggestion {
                suggestion_type: SuggestionType::TagSuggestion,
                confidence,
                description: format!("이 태그는 현재 태그와 자주 함께 사용됩니다: {}", tag),
                action: SuggestionAction::AddTag {
                    facet,
                    tag: tag.clone(),
                },
            });
        }

        suggestions
    }

    /// Suggest relations based on content patterns
    fn suggest_relations_from_patterns(
        frontmatter: &Frontmatter,
        all_notes: &[Frontmatter],
    ) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();

        // Pattern 1: Same domain tags -> extends relation
        for other in all_notes {
            if other.id == frontmatter.id {
                continue;
            }

            let common_domain_tags = Self::get_common_domain_tags(frontmatter, other);
            if common_domain_tags.len() >= 2 {
                // Already has relation?
                let has_relation = frontmatter.relations.iter()
                    .any(|r| r.target == other.title);

                if !has_relation {
                    suggestions.push(Suggestion {
                        suggestion_type: SuggestionType::RelationSuggestion,
                        confidence: 0.6,
                        description: format!(
                            "'{}' 노트와 공통 분야 태그가 있습니다. 확장 관계를 고려하세요.",
                            other.title
                        ),
                        action: SuggestionAction::AddRelation {
                            relation_type: RelationType::Extends,
                            target: other.title.clone(),
                            strength: 0.5,
                        },
                    });
                }
            }
        }

        // Pattern 2: PAPER -> THEO (implements)
        if frontmatter.note_type == super::types::NoteType::PAPER {
            for other in all_notes {
                if matches!(other.note_type, super::types::NoteType::THEO) {
                    let common_tags = Self::get_common_domain_tags(frontmatter, other);
                    if !common_tags.is_empty() {
                        suggestions.push(Suggestion {
                            suggestion_type: SuggestionType::RelationSuggestion,
                            confidence: 0.7,
                            description: format!(
                                "이 논문은 이론 노트 '{}'를 구현할 수 있습니다.",
                                other.title
                            ),
                            action: SuggestionAction::AddRelation {
                                relation_type: RelationType::Implements,
                                target: other.title.clone(),
                                strength: 0.6,
                            },
                        });
                    }
                }
            }
        }

        suggestions
    }

    /// Suggest quality improvements
    fn suggest_quality_improvements(frontmatter: &Frontmatter) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();

        // No tags
        if Self::get_all_tags(frontmatter).is_empty() {
            suggestions.push(Suggestion {
                suggestion_type: SuggestionType::QualityImprovement,
                confidence: 0.95,
                description: "이 노트에 태그가 없습니다. 분야 태그를 추가하세요.".to_string(),
                action: SuggestionAction::AddTag {
                    facet: "domain".to_string(),
                    tag: "".to_string(),
                },
            });
        }

        // No relations but high maturity
        if frontmatter.relations.is_empty() && frontmatter.state.maturity >= 3 {
            suggestions.push(Suggestion {
                suggestion_type: SuggestionType::QualityImprovement,
                confidence: 0.75,
                description: "성숙도가 높지만 다른 노트와의 관계가 없습니다.".to_string(),
                action: SuggestionAction::AddRelation {
                    relation_type: RelationType::Extends,
                    target: "".to_string(),
                    strength: 0.5,
                },
            });
        }

        suggestions
    }

    /// Get all tags from frontmatter
    fn get_all_tags(frontmatter: &Frontmatter) -> Vec<String> {
        let mut tags = Vec::new();
        tags.extend(frontmatter.tags.domain.clone());
        tags.extend(frontmatter.tags.who.clone());
        tags.extend(frontmatter.tags.org.clone());
        tags.extend(frontmatter.tags.ctx.clone());
        tags
    }

    /// Get common domain tags between two frontmatters
    fn get_common_domain_tags(fm1: &Frontmatter, fm2: &Frontmatter) -> Vec<String> {
        let tags1 = &fm1.tags.domain;
        let tags2 = &fm2.tags.domain;

        tags1.iter()
            .filter(|t| tags2.contains(t))
            .cloned()
            .collect()
    }
}
