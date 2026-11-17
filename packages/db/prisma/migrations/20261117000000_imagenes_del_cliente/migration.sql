-- D-047: imágenes y stickers del cliente (se describen con el modelo y se borran).
ALTER TYPE "MediaKind" ADD VALUE 'IMAGE';
ALTER TYPE "UsageKind" ADD VALUE 'INBOUND_IMAGE';
