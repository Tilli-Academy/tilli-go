-- CR fields, admin-managed lists and permission-based access (PR #7 follow-up §1-3).
-- Additive: old free-text columns are kept with their data; existing values become list rows.

-- AlterTable
ALTER TABLE "change_requests" ADD COLUMN     "change_type_id" TEXT,
ADD COLUMN     "code_freeze_date" TIMESTAMP(3),
ADD COLUMN     "date_presented" TIMESTAMP(3),
ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "decided_by_id" TEXT,
ADD COLUMN     "decision" TEXT,
ADD COLUMN     "downtime_hours" DOUBLE PRECISION,
ADD COLUMN     "priority_id" TEXT,
ADD COLUMN     "release_type_id" TEXT,
ADD COLUMN     "team_id" TEXT,
ALTER COLUMN "product" DROP NOT NULL,
ALTER COLUMN "change_type" DROP NOT NULL,
ALTER COLUMN "release_type" DROP NOT NULL,
ALTER COLUMN "priority" DROP NOT NULL,
ALTER COLUMN "impact" DROP NOT NULL;

-- CreateTable
CREATE TABLE "list_values" (
    "id" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "key" TEXT,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "list_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_products" (
    "change_request_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,

    CONSTRAINT "change_products_pkey" PRIMARY KEY ("change_request_id","product_id")
);

-- CreateTable
CREATE TABLE "change_documents" (
    "id" TEXT NOT NULL,
    "change_request_id" TEXT NOT NULL,
    "document_type_id" TEXT NOT NULL,
    "attachment_id" TEXT,
    "url" TEXT,
    "added_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_links" (
    "from_id" TEXT NOT NULL,
    "to_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_links_pkey" PRIMARY KEY ("from_id","to_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role","permission")
);

-- CreateIndex
CREATE INDEX "list_values_list_sort_order_idx" ON "list_values"("list", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "list_values_list_key_key" ON "list_values"("list", "key");

-- CreateIndex
CREATE INDEX "change_products_product_id_idx" ON "change_products"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_documents_change_request_id_document_type_id_key" ON "change_documents"("change_request_id", "document_type_id");

-- CreateIndex
CREATE INDEX "change_links_to_id_idx" ON "change_links"("to_id");

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_change_type_id_fkey" FOREIGN KEY ("change_type_id") REFERENCES "list_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_release_type_id_fkey" FOREIGN KEY ("release_type_id") REFERENCES "list_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_priority_id_fkey" FOREIGN KEY ("priority_id") REFERENCES "list_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "list_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_products" ADD CONSTRAINT "change_products_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_products" ADD CONSTRAINT "change_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "list_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_documents" ADD CONSTRAINT "change_documents_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_documents" ADD CONSTRAINT "change_documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "list_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_documents" ADD CONSTRAINT "change_documents_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "change_attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_links" ADD CONSTRAINT "change_links_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_links" ADD CONSTRAINT "change_links_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Data: list values ─────────────────────────────────────────────────────
-- Fixed lists (keys drive rules; admins change labels/colours only)
INSERT INTO "list_values" ("id","list","key","label","color","sort_order","updated_at") VALUES
  (gen_random_uuid()::text,'risk','LOW','Low','#16a34a',1,now()),
  (gen_random_uuid()::text,'risk','MEDIUM','Medium','#d97706',2,now()),
  (gen_random_uuid()::text,'risk','HIGH','High','#dc2626',3,now()),
  (gen_random_uuid()::text,'decision','APPROVED','Approved','#16a34a',1,now()),
  (gen_random_uuid()::text,'decision','REQUEST_INFO','Request more info','#d97706',2,now()),
  (gen_random_uuid()::text,'decision','DEFERRED','Deferred','#64748b',3,now()),
  (gen_random_uuid()::text,'decision','REJECTED','Rejected','#dc2626',4,now());

-- Starting values (admin-configurable)
INSERT INTO "list_values" ("id","list","label","color","sort_order","updated_at") VALUES
  (gen_random_uuid()::text,'change_type','Product Enhancement',NULL,1,now()),
  (gen_random_uuid()::text,'change_type','Customer Change',NULL,2,now()),
  (gen_random_uuid()::text,'change_type','Emergency Fix','#dc2626',3,now()),
  (gen_random_uuid()::text,'change_type','Demand',NULL,4,now()),
  (gen_random_uuid()::text,'change_type','Project',NULL,5,now()),
  (gen_random_uuid()::text,'change_type','Infra Task',NULL,6,now()),
  (gen_random_uuid()::text,'change_type','New Product',NULL,7,now()),
  (gen_random_uuid()::text,'release_type','Major',NULL,1,now()),
  (gen_random_uuid()::text,'release_type','Minor',NULL,2,now()),
  (gen_random_uuid()::text,'priority','Critical','#dc2626',1,now()),
  (gen_random_uuid()::text,'priority','High','#ea580c',2,now()),
  (gen_random_uuid()::text,'priority','Medium','#ca8a04',3,now()),
  (gen_random_uuid()::text,'priority','Low','#64748b',4,now()),
  (gen_random_uuid()::text,'supporting_document','Release Notes',NULL,1,now()),
  (gen_random_uuid()::text,'supporting_document','Test Results Document',NULL,2,now()),
  (gen_random_uuid()::text,'supporting_document','Risk Assessment Document',NULL,3,now()),
  (gen_random_uuid()::text,'supporting_document','Impact Analysis',NULL,4,now()),
  (gen_random_uuid()::text,'supporting_document','Rollback Plan',NULL,5,now()),
  (gen_random_uuid()::text,'supporting_document','CAB approval Email',NULL,6,now()),
  (gen_random_uuid()::text,'supporting_document','Deployment Plan',NULL,7,now()),
  (gen_random_uuid()::text,'supporting_document','Features List',NULL,8,now());

-- Values already used by existing change requests. Old change/release types that
-- were replaced become inactive: they stay on old CRs but leave the pickers.
INSERT INTO "list_values" ("id","list","label","sort_order","active","updated_at")
SELECT gen_random_uuid()::text, 'change_type', v, 100, false, now()
FROM (SELECT DISTINCT "change_type" AS v FROM "change_requests" WHERE "change_type" IS NOT NULL AND "change_type" <> 'Emergency') x
WHERE NOT EXISTS (SELECT 1 FROM "list_values" l WHERE l."list" = 'change_type' AND l."label" = x.v);

INSERT INTO "list_values" ("id","list","label","sort_order","active","updated_at")
SELECT gen_random_uuid()::text, 'release_type', v, 100, false, now()
FROM (SELECT DISTINCT "release_type" AS v FROM "change_requests" WHERE "release_type" NOT IN ('Major release','Minor release')) x
WHERE NOT EXISTS (SELECT 1 FROM "list_values" l WHERE l."list" = 'release_type' AND l."label" = x.v);

INSERT INTO "list_values" ("id","list","label","sort_order","updated_at")
SELECT gen_random_uuid()::text, 'priority', v, 100, now()
FROM (SELECT DISTINCT "priority" AS v FROM "change_requests" WHERE "priority" IS NOT NULL) x
WHERE NOT EXISTS (SELECT 1 FROM "list_values" l WHERE l."list" = 'priority' AND l."label" = x.v);

INSERT INTO "list_values" ("id","list","label","sort_order","updated_at")
SELECT gen_random_uuid()::text, 'product', v, row_number() OVER (ORDER BY v), now()
FROM (SELECT DISTINCT "product" AS v FROM "change_requests" WHERE "product" IS NOT NULL) x;

-- ── Data: point existing change requests at the list rows ─────────────────
UPDATE "change_requests" c SET "change_type_id" = l."id" FROM "list_values" l
WHERE l."list" = 'change_type' AND l."label" = CASE c."change_type" WHEN 'Emergency' THEN 'Emergency Fix' ELSE c."change_type" END;

UPDATE "change_requests" c SET "release_type_id" = l."id" FROM "list_values" l
WHERE l."list" = 'release_type' AND l."label" = CASE c."release_type" WHEN 'Major release' THEN 'Major' WHEN 'Minor release' THEN 'Minor' ELSE c."release_type" END;

UPDATE "change_requests" c SET "priority_id" = l."id" FROM "list_values" l
WHERE l."list" = 'priority' AND l."label" = c."priority";

INSERT INTO "change_products" ("change_request_id","product_id")
SELECT c."id", l."id" FROM "change_requests" c JOIN "list_values" l ON l."list" = 'product' AND l."label" = c."product";

-- Risk / impact become fixed keys (Low → LOW)
UPDATE "change_requests" SET "risk" = upper("risk"), "impact" = upper("impact");

-- Changes approved before decisions existed
UPDATE "change_requests" SET "decision" = 'APPROVED', "decided_at" = "approved_at", "decided_by_id" = "approved_by_id"
WHERE "approved_at" IS NOT NULL;

-- ── Data: permissions per role (replaces CR_APPROVER_ROLES) ────────────────
INSERT INTO "role_permissions" ("role","permission") VALUES
  ('admin','cr.create'),('admin','cr.edit'),('admin','cr.decide'),('admin','cr.close'),
  ('admin','cutover.manage'),('admin','task.edit'),('admin','task.delete'),
  ('admin','project.manage'),('admin','admin.lists'),
  ('user','cr.create'),('user','cr.edit'),('user','task.edit');
