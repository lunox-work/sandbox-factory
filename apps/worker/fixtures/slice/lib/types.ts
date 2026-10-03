export interface Config {
  name: string;
  nested: Nested;
}

export interface Nested {
  enabled: boolean;
}

export type Unrelated = string;
