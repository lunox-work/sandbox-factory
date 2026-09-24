CREATE TABLE "handle" (
	"handle" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"organization_id" text,
	CONSTRAINT "handle_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "handle_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "handle_one_holder" CHECK (num_nonnulls("handle"."user_id", "handle"."organization_id") = 1),
	CONSTRAINT "handle_lowercase" CHECK ("handle"."handle" = lower("handle"."handle"))
);
--> statement-breakpoint
ALTER TABLE "handle" ADD CONSTRAINT "handle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle" ADD CONSTRAINT "handle_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;