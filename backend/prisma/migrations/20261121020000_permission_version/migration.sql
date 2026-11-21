-- Permission changes apply at once on every API instance: any change to role_permissions
-- (from the app or plain SQL) bumps this single number; the API reloads its cached copy
-- of role_permissions whenever the number differs. Additive only.
CREATE TABLE "permission_version" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "permission_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "permission_version_single_row" CHECK ("id" = 1)
);
INSERT INTO "permission_version" ("id", "version") VALUES (1, 1);

CREATE FUNCTION "bump_permission_version"() RETURNS trigger AS $$
BEGIN
  UPDATE "permission_version" SET "version" = "version" + 1 WHERE "id" = 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "role_permissions_changed"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "role_permissions"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_permission_version"();
