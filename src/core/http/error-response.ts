import { z } from '@hono/zod-openapi';

/**
 * Sobre de error comun documentado en OpenAPI.
 *
 * Las rutas no documentan los mensajes: el contrato estable es `error.code`, y
 * los codigos posibles se enumeran en la descripcion de cada respuesta.
 */
export const errorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
    requestId: z.string().optional(),
  })
  .openapi('ErrorResponse');

/** Entrada lista para `responses` de `createRoute`. */
export function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: errorResponseSchema } },
  };
}
