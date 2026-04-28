import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  SAPLING_PORT: z.coerce.number().int().positive().default(3333),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PAYLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MCP_TOKEN: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}
