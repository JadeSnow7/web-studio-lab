import { z } from 'zod';

export const ChatSlotSchema = z.enum(['conv-personal-default', 'conv-space-taskflow-demo-impl']);
export type ChatSlot = z.infer<typeof ChatSlotSchema>;
