/**
 * The diagram skin: Diagram Design's semantic roles
 * (https://github.com/cathrynlavery/diagram-design, `references/style-guide.md`),
 * which every diagram the product writes or draws takes its colors from.
 *
 * A contract, not a style: the worker writes a graph's `.dot` file in the
 * light skin, so it reads on white paper wherever it is opened, and the
 * workbench turns exactly these values into the dark skin when it draws one.
 * A color outside this table is turned by lightness alone.
 *
 * Roles, not hues: `accent` is for the one or two things a reader looks at
 * first (a rule violation, a cycle), never a category; `link` is for calls
 * that leave the system.
 */
export const DIAGRAM_SKIN = {
  light: {
    /** Page background. */
    paper: "#f5f5f5",
    /** Container background, a step below the page. */
    paper2: "#ececec",
    /** A node's fill: raised above the page. */
    node: "#ffffff",
    /** Primary text and stroke. */
    ink: "#2d3142",
    /** Secondary text and the default arrow. */
    muted: "#4f5d75",
    /** Sublabels and boundary labels. */
    soft: "#7a8399",
    /** Stronger hairlines: a container's border. */
    rule: "#bfc0c0",
    accent: "#eb6c36",
    link: "#2e5aa8",
  },
  /**
   * The same roles on the workbench's editor: its grey is the paper, so a
   * diagram sits on the page rather than in a hole cut out of it.
   */
  dark: {
    paper: "#1f1f1f",
    paper2: "#1a1a1a",
    node: "#282828",
    ink: "#f5f5f5",
    muted: "#bfc0c0",
    soft: "#8e98ac",
    rule: "#474848",
    accent: "#f08a59",
    link: "#6a95d8",
  },
} as const;

export type DiagramRole = keyof (typeof DIAGRAM_SKIN)["light"];

/**
 * What Graphviz lays text out with. It measures only the fonts it carries
 * metrics for, so a graph names these and the workbench draws them as the
 * skin's faces, which run to nearly the same widths: Geist for names,
 * Geist Mono for anything technical.
 */
export const DIAGRAM_LAYOUT_FONTS = {
  sans: "Helvetica",
  mono: "Courier",
} as const;
