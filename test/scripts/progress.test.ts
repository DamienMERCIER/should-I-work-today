import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProgress, saveProgress, type ImportProgress } from '../../scripts/lib/progress';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('loadProgress / saveProgress', () => {
  it('returns an empty default when no progress file exists yet', () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-test-'));
    const progress = loadProgress(join(dir, 'progress.json'));
    expect(progress).toEqual({ letters: [], slugs: [], processed: {} });
  });

  it('round-trips saved progress, including the discovered slug list', () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-test-'));
    const path = join(dir, 'progress.json');
    const progress: ImportProgress = {
      letters: ['A', 'B'],
      slugs: ['Aussie-Pipe', 'Bells-Beach'],
      processed: {
        Muizenberg: { status: 'spot', name: 'Muizenberg', lat: -34.1026, lon: 18.4737, facing: 142.3167, type: 'Beach' },
        Gone: { status: 'skipped', reason: '404' },
      },
    };
    saveProgress(path, progress);
    expect(loadProgress(path)).toEqual(progress);
  });

  it('does not leave a stray temp file behind after saving', () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-test-'));
    const path = join(dir, 'progress.json');
    saveProgress(path, { letters: [], slugs: [], processed: {} });
    expect(readdirSync(dir)).toEqual(['progress.json']);
  });

  it('recovers gracefully (empty default) from a corrupted progress file, e.g. an interrupted write', () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-test-'));
    const path = join(dir, 'progress.json');
    writeFileSync(path, '{ "letters": ["A"'); // truncated JSON
    expect(loadProgress(path)).toEqual({ letters: [], slugs: [], processed: {} });
  });

  it('lets a later save overwrite an earlier one (resume picks up where it left off)', () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-test-'));
    const path = join(dir, 'progress.json');
    saveProgress(path, { letters: ['A'], slugs: [], processed: {} });
    saveProgress(path, { letters: ['A', 'B'], slugs: [], processed: {} });
    expect(loadProgress(path)).toEqual({ letters: ['A', 'B'], slugs: [], processed: {} });
  });
});
