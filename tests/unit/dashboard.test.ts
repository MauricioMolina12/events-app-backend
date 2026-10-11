import { describe, expect, it } from 'vitest';
import type { HourBucketRow } from '../../src/modules/dashboard/dashboard.repository';
import { buildTimeline, eventPhase } from '../../src/modules/dashboard/dashboard.service';

const at = (iso: string): Date => new Date(iso);
const hourOf = (iso: string): number => Date.parse(iso) / 3_600_000;
const row = (iso: string, titulares: number, companions = 0): HourBucketRow => ({
  hour: hourOf(iso),
  titulares,
  companions,
  recent: 0,
});

describe('eventPhase', () => {
  const base = {
    status: 'published' as const,
    startsAt: at('2026-11-28T10:00:00Z'),
    endsAt: at('2026-11-28T20:00:00Z'),
    registrationOpensAt: at('2026-11-01T00:00:00Z'),
    registrationClosesAt: at('2026-11-27T23:59:00Z'),
  };

  it('sigue las fechas de un evento publicado', () => {
    expect(eventPhase(base, at('2026-10-15T00:00:00Z'))).toBe('upcoming');
    expect(eventPhase(base, at('2026-11-10T00:00:00Z'))).toBe('registration_open');
    expect(eventPhase(base, at('2026-11-28T05:00:00Z'))).toBe('registration_closed');
    expect(eventPhase(base, at('2026-11-28T12:00:00Z'))).toBe('in_progress');
    expect(eventPhase(base, at('2026-11-29T00:00:00Z'))).toBe('finished');
  });

  it('un evento terminado nunca se presenta como activo, aunque siga publicado', () => {
    expect(eventPhase({ ...base, status: 'closed' }, at('2026-12-01T00:00:00Z'))).toBe('finished');
    expect(eventPhase({ ...base, status: 'closed' }, at('2026-11-10T00:00:00Z'))).toBe(
      'registration_closed',
    );
  });

  it('sin fecha de fin, el evento dura un dia desde su inicio', () => {
    const oneDay = { ...base, endsAt: null };
    expect(eventPhase(oneDay, at('2026-11-28T23:00:00Z'))).toBe('in_progress');
    expect(eventPhase(oneDay, at('2026-11-29T10:00:01Z'))).toBe('finished');
  });

  it('borrador y archivado no dependen de las fechas', () => {
    expect(eventPhase({ ...base, status: 'draft' }, at('2026-11-28T12:00:00Z'))).toBe('draft');
    expect(eventPhase({ ...base, status: 'archived' }, at('2026-11-10T00:00:00Z'))).toBe('archived');
  });

  it('sin fechas, un evento publicado tiene las inscripciones abiertas', () => {
    const open = {
      status: 'published' as const,
      startsAt: null,
      endsAt: null,
      registrationOpensAt: null,
      registrationClosesAt: null,
    };
    expect(eventPhase(open, at('2026-11-10T00:00:00Z'))).toBe('registration_open');
  });
});

describe('buildTimeline', () => {
  it('sin inscripciones no inventa tramos', () => {
    expect(buildTimeline([], 'America/Bogota')).toEqual({
      timezone: 'America/Bogota',
      granularity: 'day',
      total: 0,
      buckets: [],
    });
  });

  it('agrupa por hora local cuando todo cae en menos de dos dias y rellena con ceros', () => {
    const timeline = buildTimeline(
      [row('2026-11-25T10:00:00Z', 2, 3), row('2026-11-25T13:00:00Z', 1)],
      'America/Bogota',
    );
    expect(timeline.granularity).toBe('hour');
    expect(timeline.total).toBe(3);
    expect(timeline.buckets.map((bucket) => [bucket.hour, bucket.titulares, bucket.cumulative])).toEqual([
      [5, 2, 2],
      [6, 0, 2],
      [7, 0, 2],
      [8, 1, 3],
    ]);
    expect(timeline.buckets[0]).toMatchObject({ date: '2026-11-25', people: 5 });
  });

  it('agrupa por dia en la zona horaria del evento, no en UTC', () => {
    const timeline = buildTimeline(
      [
        // 22:00 del 24 en Bogota.
        row('2026-11-25T03:00:00Z', 1),
        row('2026-11-26T15:00:00Z', 2),
        row('2026-11-28T15:00:00Z', 4),
      ],
      'America/Bogota',
    );
    expect(timeline.granularity).toBe('day');
    expect(timeline.buckets.map((bucket) => [bucket.date, bucket.titulares])).toEqual([
      ['2026-11-24', 1],
      ['2026-11-25', 0],
      ['2026-11-26', 2],
      ['2026-11-27', 0],
      ['2026-11-28', 4],
    ]);
    expect(timeline.buckets.at(-1)?.cumulative).toBe(7);
  });

  it('pasa a semanas en rangos largos, empezando en lunes', () => {
    const timeline = buildTimeline(
      [row('2026-01-07T15:00:00Z', 1), row('2026-08-20T15:00:00Z', 1)],
      'America/Bogota',
    );
    expect(timeline.granularity).toBe('week');
    expect(timeline.buckets[0]?.date).toBe('2026-01-05');
    for (const bucket of timeline.buckets) {
      expect(new Date(`${bucket.date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    expect(timeline.buckets.reduce((sum, bucket) => sum + bucket.titulares, 0)).toBe(2);
  });
});
