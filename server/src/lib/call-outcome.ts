/**
 * Terminal status and talk time when a channel is destroyed.
 * `ringing` was never answered. `ai` means the receptionist already answered
 * and nobody else took the call, so it closes as answered.
 */
export function callOutcome(input: {
  status: string;
  direction: 'inbound' | 'outbound' | 'internal';
  answeredAt?: Date | null;
  now?: number;
}): { status: string; duration_s: number | null } {
  let status = input.status;
  if (status === 'ringing') status = input.direction === 'inbound' ? 'missed' : 'abandoned';
  else if (status === 'ai') status = 'answered';
  const duration_s =
    input.answeredAt == null
      ? null
      : Math.max(0, Math.round(((input.now ?? Date.now()) - input.answeredAt.getTime()) / 1000));
  return { status, duration_s };
}
