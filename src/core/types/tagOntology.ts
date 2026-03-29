// Tag style configuration (portable with vault)
export interface TagStyle {
  color?: string;
  borderColor?: string;
}

export interface TagDefinition {
  label: string;
  description?: string;
  aliases?: string[];
  broader?: string; // Parent tag
  children?: string[]; // Child tags
  related?: string[]; // Related tags
  style?: TagStyle; // Visual style (color, border) - portable with vault
}

export interface TagOntology {
  definitions: Record<string, TagDefinition>;
  synonyms: Record<string, string>;
}

export interface TagNode {
  id: string;
  label: string;
  children?: TagNode[];
  parent?: string;
}

export type FacetNamespace = 'domain' | 'who' | 'org' | 'ctx';

export type FacetIconName = 'BookOpen' | 'Users' | 'Building2' | 'Activity';

export const FACET_NAMESPACES: Array<{ namespace: FacetNamespace; label: string; description: string; icon: FacetIconName }> = [
  { namespace: 'domain', label: '주제', description: '노트의 주요 주제나 분야', icon: 'BookOpen' },
  { namespace: 'who', label: '대상', description: '관련된 인물, 조직, 프로젝트', icon: 'Users' },
  { namespace: 'org', label: '맥락', description: '작성 배경, 상황, 용도', icon: 'Building2' },
  { namespace: 'ctx', label: '상태', description: '진행 상태, 우선순위', icon: 'Activity' },
];
