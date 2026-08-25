export type MotionSample = {
  time: number;
  difference: number;
};

export type MotionEvent = {
  id: number;
  start: number;
  end: number;
  peakTime: number;
  peakDifference: number;
  confidence: number;
};

export type VideoDecodeResult = {
  events: MotionEvent[];
  samples: MotionSample[];
  threshold: number;
  sampleInterval: number;
};

type DecodeOptions = {
  startTime: number;
  endTime: number;
  onProgress?: (progress: number) => void;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function waitForSeek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.01));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.01) {
      window.requestAnimationFrame(() => resolve());
      return;
    }

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Il browser non riesce a leggere questo punto del video.'));
    }, 8000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Errore durante la lettura del video.'));
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = target;
  });
}

function grayscaleFrame(context: CanvasRenderingContext2D, width: number, height: number) {
  const { data } = context.getImageData(0, 0, width, height);
  const frame = new Uint8Array(width * height);
  for (let source = 0, target = 0; source < data.length; source += 4, target += 1) {
    frame[target] = Math.round(data[source] * 0.299 + data[source + 1] * 0.587 + data[source + 2] * 0.114);
  }
  return frame;
}

function frameDifference(previous: Uint8Array, current: Uint8Array) {
  let total = 0;
  for (let index = 0; index < current.length; index += 1) {
    total += Math.abs(current[index] - previous[index]);
  }
  return total / current.length;
}

export function detectMotionEvents(samples: MotionSample[], sampleInterval: number): Omit<VideoDecodeResult, 'sampleInterval'> {
  const differences = samples.slice(1).map((sample) => sample.difference);
  const baseline = median(differences);
  const deviation = median(differences.map((value) => Math.abs(value - baseline)));
  const threshold = Math.max(4.5, baseline + Math.max(2.8, deviation * 3.2));
  const active = samples.filter((sample) => sample.difference >= threshold);
  const rawEvents: MotionSample[][] = [];

  active.forEach((sample) => {
    const current = rawEvents.at(-1);
    if (!current || sample.time - current.at(-1)!.time > sampleInterval * 2.4) {
      rawEvents.push([sample]);
    } else {
      current.push(sample);
    }
  });

  const events = rawEvents
    .filter((group) => group.some((sample) => sample.difference >= threshold * 1.08))
    .map((group, index) => {
      const peak = group.reduce((best, sample) => sample.difference > best.difference ? sample : best, group[0]);
      const strength = (peak.difference - threshold) / Math.max(1, threshold);
      return {
        id: index + 1,
        start: Math.max(0, group[0].time - sampleInterval),
        end: group.at(-1)!.time + sampleInterval,
        peakTime: peak.time,
        peakDifference: peak.difference,
        confidence: Math.round(Math.min(98, Math.max(35, 48 + strength * 70))),
      };
    })
    .filter((event) => event.end - event.start <= 4.5)
    .slice(0, 180);

  return { events, samples, threshold };
}

export async function decodeVideoMotion(video: HTMLVideoElement, options: DecodeOptions): Promise<VideoDecodeResult> {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
    throw new Error('Attendi che il video sia pronto prima di avviare l’analisi.');
  }

  const startTime = Math.max(0, Math.min(options.startTime, video.duration));
  const endTime = Math.max(startTime, Math.min(options.endTime, video.duration));
  if (endTime - startTime < 1) throw new Error('Seleziona almeno un secondo di video da analizzare.');

  const sampleInterval = Math.max(0.18, (endTime - startTime) / 520);
  const sampleCount = Math.max(2, Math.floor((endTime - startTime) / sampleInterval) + 1);
  const canvas = document.createElement('canvas');
  const portrait = video.videoHeight >= video.videoWidth;
  canvas.width = portrait ? 72 : 112;
  canvas.height = portrait ? 112 : 72;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Il browser non supporta l’analisi dei fotogrammi.');

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();
  const samples: MotionSample[] = [];
  let previous: Uint8Array | null = null;

  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(endTime, startTime + index * sampleInterval);
      await waitForSeek(video, time);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const current = grayscaleFrame(context, canvas.width, canvas.height);
      samples.push({ time, difference: previous ? frameDifference(previous, current) : 0 });
      previous = current;
      options.onProgress?.((index + 1) / sampleCount);
    }
  } finally {
    await waitForSeek(video, originalTime).catch(() => undefined);
    if (!wasPaused) await video.play().catch(() => undefined);
  }

  return { ...detectMotionEvents(samples, sampleInterval), sampleInterval };
}
