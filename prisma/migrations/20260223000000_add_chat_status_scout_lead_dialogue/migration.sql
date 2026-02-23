-- Add CHAT value to UserStatus enum
ALTER TYPE "UserStatus" ADD VALUE 'CHAT';

-- Change User.status default to NEW
ALTER TABLE "User" ALTER COLUMN "status" SET DEFAULT 'NEW';

-- Add dialogueId column to ScoutLead
ALTER TABLE "ScoutLead" ADD COLUMN "dialogueId" INTEGER;

-- Add foreign key for dialogueId with SET NULL on delete
ALTER TABLE "ScoutLead" ADD CONSTRAINT "ScoutLead_dialogueId_fkey"
  FOREIGN KEY ("dialogueId") REFERENCES "Dialogue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Update ScannedChat FK to cascade delete
ALTER TABLE "ScoutLead" DROP CONSTRAINT IF EXISTS "ScoutLead_scannedChatId_fkey";
ALTER TABLE "ScoutLead" ADD CONSTRAINT "ScoutLead_scannedChatId_fkey"
  FOREIGN KEY ("scannedChatId") REFERENCES "ScannedChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
