import { z } from 'zod';

export const ChatSlotSchema = z.union([
  z.enum(['conv-personal-default', 'conv-space-taskflow-demo-impl']),
  z
    .string()
    .regex(/^session-[a-zA-Z0-9-]+$/)
    .max(200),
]);
export type ChatSlot = z.infer<typeof ChatSlotSchema>;
