-- Preferencia de facturacion electronica declarada en el alta.
-- Por ahora solo se almacena; no dispara emision ni envio.
ALTER TABLE `registrations` ADD `requires_electronic_invoice` integer DEFAULT 0 NOT NULL;
