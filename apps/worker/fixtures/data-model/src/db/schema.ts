import {
  integer,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const stamp = (name: string) => timestamp(name, { withTimezone: true });
const audited = {
  createdAt: stamp("created_at").defaultNow().notNull(),
};

export const plan = pgEnum("plan", ["free", "team"]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  plan: plan("plan").default("free").notNull(),
  tags: text("tags").array(),
  ...audited,
});

export const memberships = pgTable(
  "memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull(),
    seats: integer().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    unique("one_seat").on(t.userId, t.seats),
  ],
);

const billing = pgSchema("billing");

export const invoices = billing.table("invoices", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id),
  owner: text("owner").references(() => nowhere.id),
});
