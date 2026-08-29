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

export type FacetNamespace = 'domain' | 'who' | 'org' | 'ctx' | 'key' | 'proj' | 'acad';

export type FacetIconName = 'BookOpen' | 'Users' | 'Building2' | 'Activity'
  | 'Hash' | 'Briefcase' | 'GraduationCap';

// 🔴 축 표는 **여기 하나뿐이다** (2026-08-29). 같은 개념이 `FACET_INFOS`
//    와 두 벌로 갈라져 있었고, 노트 창 패널은 이쪽(네 축·어긋난 이름)을
//    읽었다 — 실측 **375 노트 중 186(50%)** 이 `key`·`proj`·`acad` 태그를
//    창 안에서 못 보고 고치지도 못했다. `FACET_INFOS` 는 이제 이 표에서
//    파생된다 (core/types/index.ts).
//    이름은 CLAUDE 3-3 의 여섯 축 그대로다 — org=기관 · ctx=맥락이지
//    「맥락/상태」가 아니다.
//    label·description 은 **i18n 키**다 (화면에서 t() 로 푼다).
export const FACET_NAMESPACES: Array<{ namespace: FacetNamespace; label: string; description: string; icon: FacetIconName }> = [
  { namespace: 'domain', label: 'facetDomain', description: 'facetDomainDesc', icon: 'BookOpen' },
  { namespace: 'key', label: 'facetKey', description: 'facetKeyDesc', icon: 'Hash' },
  { namespace: 'who', label: 'facetWho', description: 'facetWhoDesc', icon: 'Users' },
  { namespace: 'org', label: 'facetOrg', description: 'facetOrgDesc', icon: 'Building2' },
  { namespace: 'ctx', label: 'facetCtx', description: 'facetCtxDesc', icon: 'Activity' },
  { namespace: 'proj', label: 'facetProj', description: 'facetProjDesc', icon: 'Briefcase' },
  { namespace: 'acad', label: 'facetAcad', description: 'facetAcadDesc', icon: 'GraduationCap' },
];
