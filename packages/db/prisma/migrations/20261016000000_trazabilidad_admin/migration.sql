-- D-002: la Trazabilidad la ve todo ADMIN (un solo administrador configura el robot); se retira
-- el permiso aparte «Ver conversaciones».

-- AlterTable
ALTER TABLE "AdminUser" DROP COLUMN "conversationViewer";
