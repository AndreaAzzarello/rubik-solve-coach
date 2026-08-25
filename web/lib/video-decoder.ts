export type MotionSample = {
  time: number;
  difference: number;
  coverage?: number;
  centerBias?: number;
};

export type MotionKind = 'face-turn' | 'global-motion';

export type MotionEvent = {
  id: number;
  start: number;
  end: number;
  peakTime: number;
  peakDifference: number;
  confidence: number;
  motionKind: MotionKind;
};

export type VideoDecodeResult = {
  events: MotionEvent[];
  samples: MotionSample[];
  threshold: number;
  sampleInterval: number;
  analyzedRegion: 'cube-focus';
};

type DecodeOptions = {
  startTime: number;
  endTime: number;
  onProgress?: (progress: number) => void;
};

type FrameSignature = {
  luma: Uint8Array;
  chromaBlue: Uint8Array;
  chromaRed: Uint8Array;
};

type DifferenceMeasurement = {
  score: number;
  coverage: number;
  centerBias: number;
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

function frameSignature(context: CanvasRenderingContext2D, width: number, height: number): FrameSignature {
  const { data } = context.getImageData(0, 0, width, height);
  const size = width * height;
  const luma = new Uint8Array(size);
  const chromaBlue = new Uint8Array(size);
  const chromaRed = new Uint8Array(size);

  for (let source = 0, target = 0; source < data.length; source += 4, target += 1) {
    const red = data[source];
    const green = data[source + 1];
    const blue = data[source + 2];
    const brightness = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    luma[target] = brightness;
    chromaBlue[target] = Math.round(Math.min(255, Math.max(0, 128 + (blue - brightness) * 0.565)));
    chromaRed[target] = Math.round(Math.min(255, Math.max(0, 128 + (red - brightness) * 0.713)));
  }

  return { luma, chromaBlue, chromaRed };
}

function frameDifference(
  previous: FrameSignature,
  current: FrameSignature,
  width: number,
  height: number,
): DifferenceMeasurement {
  let exposureShift = 0;
  for (let index = 0; index < current.luma.length; index += 1) {
    exposureShift += current.luma[index] - previous.luma[index];
  }
  exposureShift /= current.luma.length;

  let centerTotal = 0;
  let centerWeight = 0;
  let outerTotal = 0;
  let outerWeight = 0;
  let changedWeight = 0;
  let totalWeight = 0;

  for (let index = 0; index < current.luma.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const normalizedX = (x + 0.5) / width;
    const normalizedY = (y + 0.5) / height;
    const isCenter = normalizedX >= 0.14 && normalizedX <= 0.86 && normalizedY >= 0.12 && normalizedY <= 0.88;
    const weight = isCenter ? 1.35 : 0.48;
    const lumaDelta = Math.abs((current.luma[index] - previous.luma[index]) - exposureShift);
    const chromaDelta = (
      Math.abs(current.chromaBlue[index] - previous.chromaBlue[index])
      + Math.abs(current.chromaRed[index] - previous.chromaRed[index])
    ) / 2;
    const pixelDifference = Math.min(64, lumaDelta * 0.58 + chromaDelta * 0.42);

    if (isCenter) {
      centerTotal += pixelDifference * weight;
      centerWeight += weight;
    } else {
      outerTotal += pixelDifference * weight;
      outerWeight += weight;
    }
    if (pixelDifference >= 9.5) changedWeight += weight;
    totalWeight += weight;
  }

  const centerMean = centerTotal / Math.max(1, centerWeight);
  const outerMean = outerTotal / Math.max(1, outerWeight);
  const coverage = changedWeight / Math.max(1, totalWeight);
  const centerBias = centerMean / Math.max(0.6, outerMean);

  return {
    score: centerMean * 0.74 + outerMean * 0.12 + coverage * 12,
    coverage,
    centerBias,
  };
}

function smoothSamples(samples: MotionSample[]) {
  return samples.map((sample, index) => {
    const previous = samples[Math.max(0, index - 1)].difference;
    const next = samples[Math.min(samples.length - 1, index + 1)].difference;
    return { ...sample, difference: previous * 0.22 + sample.difference * 0.56 + next * 0.22 };
  });
}

export function detectMotionEvents(samples: MotionSample[], sampleInterval: number): Omit<VideoDecodeResult, 'sampleInterval' | 'analyzedRegion'> {
  if (samples.length < 3) return { events: [], samples, threshold: 0 };

  const smoothed = smoothSamples(samples);
  const sortedDifferences = smoothed.slice(1).map((sample) => sample.difference).sort((left, right) => left - right);
  const quietBand = sortedDifferences.slice(0, Math.max(3, Math.ceil(sortedDifferences.length * 0.58)));
  const baseline = median(quietBand);
  const deviation = median(quietBand.map((value) => Math.abs(value - baseline)));
  const threshold = Math.max(2.6, baseline + Math.max(1.35, deviation * 4.2));
  const releaseThreshold = Math.max(1.8, baseline + Math.max(0.72, deviation * 1.9));
  const peakRadius = Math.max(1, Math.round(0.1 / sampleInterval));
  const minimumPeakGap = Math.max(0.14, sampleInterval * 1.65);

  const candidates = smoothed
    .slice(1, -1)
    .filter((sample, offset) => {
      const index = offset + 1;
      if (sample.difference < threshold) return false;
      const start = Math.max(0, index - peakRadius);
      const end = Math.min(smoothed.length - 1, index + peakRadius);
      for (let neighbor = start; neighbor <= end; neighbor += 1) {
        if (smoothed[neighbor].difference > sample.difference) return false;
      }
      return true;
    })
    .sort((left, right) => right.difference - left.difference);

  const selectedPeaks: MotionSample[] = [];
  candidates.forEach((candidate) => {
    if (selectedPeaks.every((peak) => Math.abs(peak.time - candidate.time) >= minimumPeakGap)) {
      selectedPeaks.push(candidate);
    }
  });
  selectedPeaks.sort((left, right) => left.time - right.time);

  const events = selectedPeaks.map((peak, index) => {
    const peakIndex = smoothed.indexOf(peak);
    const maximumRadius = Math.max(2, Math.ceil(0.75 / sampleInterval));
    let startIndex = peakIndex;
    let endIndex = peakIndex;

    while (
      startIndex > 0
      && peakIndex - startIndex < maximumRadius
      && smoothed[startIndex - 1].difference >= releaseThreshold
    ) startIndex -= 1;
    while (
      endIndex < smoothed.length - 1
      && endIndex - peakIndex < maximumRadius
      && smoothed[endIndex + 1].difference >= releaseThreshold
    ) endIndex += 1;

    const strength = (peak.difference - threshold) / Math.max(1, threshold);
    const focusBonus = Math.max(-8, Math.min(10, ((peak.centerBias ?? 1) - 1) * 12));
    // A large changed area is a useful warning for wide moves, cube rotations
    // and regrips. It is deliberately a category, not an automatic move label.
    const globalMotion = (peak.coverage ?? 0) >= 0.52;
    return {
      id: index + 1,
      start: Math.max(0, smoothed[startIndex].time - sampleInterval),
      end: smoothed[endIndex].time + sampleInterval,
      peakTime: peak.time,
      peakDifference: peak.difference,
      confidence: Math.round(Math.min(97, Math.max(36, 52 + strength * 54 + focusBonus))),
      motionKind: globalMotion ? 'global-motion' as const : 'face-turn' as const,
    };
  });

  for (let index = 0; index < events.length - 1; index += 1) {
    if (events[index].end > events[index + 1].start) {
      const midpoint = (events[index].peakTime + events[index + 1].peakTime) / 2;
      events[index].end = midpoint;
      events[index + 1].start = midpoint;
    }
  }

  return { events: events.slice(0, 240), samples, threshold };
}

export async function decodeVideoMotion(video: HTMLVideoElement, options: DecodeOptions): Promise<VideoDecodeResult> {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
    throw new Error('Attendi che il video sia pronto prima di avviare l’analisi.');
  }

  const startTime = Math.max(0, Math.min(options.startTime, video.duration));
  const endTime = Math.max(startTime, Math.min(options.endTime, video.duration));
  const duration = endTime - startTime;
  if (duration < 1) throw new Error('Seleziona almeno un secondo di video da analizzare.');

  // Il set di calibrazione include riprese lente a 30 fps e veloci a 60 fps.
  // Circa 16 campioni al secondo conservano i picchi delle fingertrick veloci
  // senza far crescere oltre misura l'analisi locale dei filmati lunghi.
  const sampleInterval = Math.max(0.06, duration / 1050);
  const sampleCount = Math.max(2, Math.floor(duration / sampleInterval) + 1);
  const portrait = video.videoHeight >= video.videoWidth;
  const canvas = document.createElement('canvas');
  canvas.width = portrait ? 96 : 128;
  canvas.height = portrait ? 128 : 96;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Il browser non supporta l’analisi dei fotogrammi.');

  const sourceWidth = video.videoWidth * (portrait ? 0.88 : 0.74);
  const sourceHeight = video.videoHeight * (portrait ? 0.68 : 0.86);
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = portrait
    ? Math.max(0, Math.min(video.videoHeight - sourceHeight, video.videoHeight * 0.08))
    : (video.videoHeight - sourceHeight) / 2;

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();
  const samples: MotionSample[] = [];
  let previous: FrameSignature | null = null;

  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(endTime, startTime + index * sampleInterval);
      await waitForSeek(video, time);
      context.drawImage(
        video,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const current = frameSignature(context, canvas.width, canvas.height);
      const measurement = previous
        ? frameDifference(previous, current, canvas.width, canvas.height)
        : { score: 0, coverage: 0, centerBias: 1 };
      samples.push({
        time,
        difference: measurement.score,
        coverage: measurement.coverage,
        centerBias: measurement.centerBias,
      });
      previous = current;
      options.onProgress?.((index + 1) / sampleCount);
    }
  } finally {
    await waitForSeek(video, originalTime).catch(() => undefined);
    if (!wasPaused) await video.play().catch(() => undefined);
  }

  return {
    ...detectMotionEvents(samples, sampleInterval),
    sampleInterval,
    analyzedRegion: 'cube-focus',
  };
}
