export type NoteType = 'NOTE' | 'MTG' | 'PAPER' | 'THEO' | 'TASK' | 'LIT' | 'EVENT' | 'CONTACT' | 'CONTAINER' | 'ADM' | 'OFA' | 'SEM' | 'DATA' | 'SETUP' | 'SKETCH';

export type WorkflowState = 'draft' | 'in-progress' | 'review' | 'final' | 'archived';
export type ConfidenceState = 'unverified' | 'verified' | 'outdated' | 'disputed';

export interface State {
  workflow: WorkflowState;
  confidence: ConfidenceState;
  maturity: number; // 1-5
}

export type RelationType =
  | 'supports'
  | 'refutes'
  | 'extends'
  | 'implements'
  | 'derives-from'
  | 'part-of'
  | 'is-example-of'
  | 'causes';

export interface Relation {
  relation_type: RelationType;
  target: string;
  strength?: number; // 0.0-1.0
}

export interface FacetedTags {
  domain?: string[];
  who?: string[];
  org?: string[];
  ctx?: string[];
  source?: string[];
  method?: string[];
  status?: string[];
  [key: string]: string[] | undefined;
}

export interface BaseFrontmatter {
  id: string;
  title: string;
  type: NoteType;
  created: string;
  modified: string;
  state: State;
  tags?: FacetedTags;
  relations?: Relation[];
  cssclasses?: string[];
  canvas?: boolean;
  [key: string]: unknown;
}

// Meeting note
export interface MeetingFrontmatter extends BaseFrontmatter {
  type: 'MTG';
  participants?: string[];
  date?: string;
}

// Paper note
export interface PaperFrontmatter extends BaseFrontmatter {
  type: 'PAPER';
  authors?: string[];
  venue?: string;
  year?: number;
  doi?: string;
  url?: string;
}

// Theory note
export interface TheoryFrontmatter extends BaseFrontmatter {
  type: 'THEO';
}

// Literature note
export interface LiteratureFrontmatter extends BaseFrontmatter {
  type: 'LIT';
  authors?: string[];
  year?: number;
  publisher?: string;
  source?: string;
  url?: string;
}

// Event note
export interface EventFrontmatter extends BaseFrontmatter {
  type: 'EVENT';
  date?: string;
  location?: string;
  organizer?: string;
  participants?: string[];
}

// Contact note
export interface ContactFrontmatter extends BaseFrontmatter {
  type: 'CONTACT';
  email?: string;
  phone?: string;
  organization?: string;
  role?: string;
}

// Container note (folder note)
export interface ContainerFrontmatter extends BaseFrontmatter {
  type: 'CONTAINER';
}

export type Frontmatter =
  | BaseFrontmatter
  | MeetingFrontmatter
  | PaperFrontmatter
  | TheoryFrontmatter
  | LiteratureFrontmatter
  | EventFrontmatter
  | ContactFrontmatter
  | ContainerFrontmatter;

export interface ValidationError {
  path: string;
  message: string;
}

export interface ParsedNote {
  frontmatter: Frontmatter | null;
  body: string;
}
