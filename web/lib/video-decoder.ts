import {
  HandDirection,
  HandSide,
  createHandMotionTracker,
} from './hand-motion';

export type MotionSample = {
  time: number;
  difference: number;
  coverage?: number;
  centerBias?: number;
  cubeDifference?: number;
  handMotion?: number;
  fingerMotion?: number;
  wristMotion?: number;
  handCount?: number;
  dominantHand?: HandSide;
  handDirection?: HandDirection;
  cubeEvidence?: number;
  handEvidence?: number;
};

export type MotionKind = 'face-turn' | 'global-motion';
export type MotionEvidence = 'cube' | 'hands' | 'combined';

export type MotionEvent = {
  id: number;
  start: number;
  end: number;
  peakTime: number;
  peakDifference: number;
  confidence: number;
  motionKind: MotionKind;
  evidence: MotionEvidence;
  cubeStrength: number;
  handStrength: number;
  dominantHand: HandSide;
  handDirection: HandDirection;
};

export type HandTrackingSummary = {
  available: boolean;
  framesWithHands: number;
  totalFrames: number;
  message?: string;
};

export type VideoDecodeResult = {
  events: MotionEvent[];
  samples: MotionSample[];
  threshold: number;
  sampleInterval: number;
  analyzedRegion: 'cube-focus';
  handTracking: HandTrackingSummary;
};

export type VideoStageKind = 'scramble' | 'inspection' | 'solve';

export type VideoStage = {
  kind: VideoStageKind;
  start: number;
  end: number;
  eventIds: number[];
};

export type SolveWindow = {
  id: number;
  start: number;
  end: number;
  eventIds: number[];
  confidence: number;
  startState: 'solved-likely' | 'scrambled-likely' | 'unknown';
  stages: VideoStage[];
};

export type VideoSegmentation = {
  windows: SolveWindow[];
  defaultWindowId: number | null;
  pauseThreshold: number;
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

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
}

function channelActivity(values: number[], minimumSpread: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const quietBand = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.58)));
  const baseline = median(quietBand);
  const deviation = median(quietBand.map((value) => Math.abs(value - baseline)));
  const spread = Math.max(
    minimumSpread,
    deviation * 6,
    percentile(sorted, 0.9) - baseline,
  );
  return values.map((value) => Math.max(0, (value - baseline) / spread));
}

/**
 * Porta variazione degli sticker e traiettorie delle mani sulla stessa scala.
 * La finestra anticipata permette a una fingertrick di sostenere la mossa che
 * diventa visibile sul cubo pochi fotogrammi dopo.
 */
export function fuseMotionEvidence(samples: MotionSample[]) {
  if (!samples.length) return samples;
  const cubeValues = samples.map((sample) => sample.cubeDifference ?? sample.difference);
  const handValues = samples.map((sample) => sample.handMotion ?? 0);
  const cubeActivity = channelActivity(cubeValues, 2.4);
  const handActivity = channelActivity(handValues, 0.035);
  const cubeBaseline = median([...cubeValues].sort((left, right) => left - right).slice(0, Math.max(3, Math.ceil(samples.length * 0.58))));
  const cubeSpread = Math.max(2.8, percentile(cubeValues, 0.9) - cubeBaseline);

  return samples.map((sample, index) => {
    let handSupport = handActivity[index] ?? 0;
    // Le dita spesso iniziano 60–180 ms prima che gli sticker cambino.
    for (let lead = 1; lead <= 3; lead += 1) {
      handSupport = Math.max(handSupport, (handActivity[index - lead] ?? 0) * (1 - lead * 0.08));
    }
    handSupport = Math.max(handSupport, (handActivity[index + 1] ?? 0) * 0.72);
    const cubeSupport = cubeActivity[index] ?? 0;
    const primary = Math.max(cubeSupport, handSupport * 0.96);
    const agreement = Math.min(cubeSupport, handSupport);
    return {
      ...sample,
      cubeDifference: cubeValues[index],
      cubeEvidence: cubeSupport,
      handEvidence: handSupport,
      difference: cubeBaseline + cubeSpread * (primary + agreement * 0.28),
    };
  });
}

function smoothSamples(samples: MotionSample[]) {
  return samples.map((sample, index) => {
    const previous = samples[Math.max(0, index - 1)].difference;
    const next = samples[Math.min(samples.length - 1, index + 1)].difference;
    return { ...sample, difference: previous * 0.22 + sample.difference * 0.56 + next * 0.22 };
  });
}

export function detectMotionEvents(samples: MotionSample[], sampleInterval: number): Omit<VideoDecodeResult, 'sampleInterval' | 'analyzedRegion' | 'handTracking'> {
  if (samples.length < 3) return { events: [], samples, threshold: 0 };

  const smoothed = smoothSamples(samples);
  const sortedDifferences = smoothed.slice(1).map((sample) => sample.difference).sort((left, right) => left - right);
  const quietBand = sortedDifferences.slice(0, Math.max(3, Math.ceil(sortedDifferences.length * 0.58)));
  const baseline = median(quietBand);
  const deviation = median(quietBand.map((value) => Math.abs(value - baseline)));
  const noiseThreshold = baseline + Math.max(1.35, deviation * 4.2);
  const activityCeiling = sortedDifferences[Math.floor((sortedDifferences.length - 1) * 0.72)];
  const threshold = Math.max(2.6, Math.min(noiseThreshold, activityCeiling));
  const releaseThreshold = Math.min(
    threshold * 0.76,
    Math.max(1.8, baseline + Math.max(0.72, deviation * 1.9)),
  );
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

    const evidenceWindow = smoothed.slice(Math.max(0, startIndex - 3), Math.min(smoothed.length, endIndex + 2));
    const cubeEvidence = Math.max(0, ...evidenceWindow.map((sample) => sample.cubeEvidence ?? 0));
    const handEvidence = Math.max(0, ...evidenceWindow.map((sample) => sample.handEvidence ?? 0));
    const handPeak = [...evidenceWindow].sort(
      (left, right) => (right.handEvidence ?? 0) - (left.handEvidence ?? 0),
    )[0];
    const hasCubeEvidence = cubeEvidence >= 0.38;
    const hasHandEvidence = handEvidence >= 0.32;
    const evidence: MotionEvidence = hasCubeEvidence && hasHandEvidence
      ? 'combined'
      : hasHandEvidence && (!hasCubeEvidence || handEvidence > cubeEvidence)
        ? 'hands'
        : 'cube';
    const strength = (peak.difference - threshold) / Math.max(1, threshold);
    const focusBonus = Math.max(-8, Math.min(10, ((peak.centerBias ?? 1) - 1) * 12));
    const agreementBonus = evidence === 'combined' ? 9 : evidence === 'hands' ? -4 : 0;
    // A large changed area is a useful warning for wide moves, cube rotations
    // and regrips. It is deliberately a category, not an automatic move label.
    const globalMotion = (peak.coverage ?? 0) >= 0.52;
    return {
      id: index + 1,
      start: Math.max(0, smoothed[startIndex].time - sampleInterval),
      end: smoothed[endIndex].time + sampleInterval,
      peakTime: peak.time,
      peakDifference: peak.difference,
      confidence: Math.round(Math.min(98, Math.max(34, 52 + strength * 54 + focusBonus + agreementBonus))),
      motionKind: globalMotion ? 'global-motion' as const : 'face-turn' as const,
      evidence,
      cubeStrength: Math.round(Math.min(100, cubeEvidence * 100)),
      handStrength: Math.round(Math.min(100, handEvidence * 100)),
      dominantHand: handPeak?.dominantHand ?? 'unknown',
      handDirection: handPeak?.handDirection ?? 'mixed',
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

function groupEventsByPause(events: MotionEvent[], pauseThreshold: number) {
  const groups: MotionEvent[][] = [];
  events.forEach((event) => {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || event.peakTime - previous.peakTime > pauseThreshold) {
      groups.push([event]);
    } else {
      current.push(event);
    }
  });
  return groups;
}

export function inferVideoSegmentation(
  events: MotionEvent[],
  rangeStart: number,
  rangeEnd: number,
): VideoSegmentation {
  if (!events.length) return { windows: [], defaultWindowId: null, pauseThreshold: 1.8 };

  const ordered = [...events].sort((left, right) => left.peakTime - right.peakTime);
  const duration = Math.max(1, rangeEnd - rangeStart);
  const sessionPauseThreshold = Math.min(45, Math.max(24, duration * 0.18));
  const sessions = groupEventsByPause(ordered, sessionPauseThreshold);
  const usableSessions = sessions.filter((session) => session.length >= 4);
  const candidateSessions = usableSessions.length ? usableSessions : [ordered];

  const windows: SolveWindow[] = candidateSessions.map((session, index) => {
    const gaps = session.slice(1).map((event, gapIndex) => event.peakTime - session[gapIndex].peakTime);
    const typicalGap = median(gaps.filter((gap) => gap <= 3.5));
    const pauseThreshold = Math.min(6, Math.max(1.45, typicalGap * 3.4));
    const minimumSuffix = Math.max(5, Math.floor(session.length * 0.35));
    let splitIndex = -1;
    let selectedPause = 0;
    let bestSplitScore = 0;

    for (let cut = 1; cut <= session.length - minimumSuffix; cut += 1) {
      const gap = session[cut].peakTime - session[cut - 1].peakTime;
      const tail = session.slice(Math.max(0, cut - 4), cut);
      const extendedRatio = tail.filter((event) => event.motionKind === 'global-motion').length / tail.length;
      const splitScore = gap + extendedRatio * 2.6 + (cut / session.length) * 0.35;
      if (gap >= pauseThreshold && splitScore > bestSplitScore) {
        selectedPause = gap;
        bestSplitScore = splitScore;
        splitIndex = cut;
      }
    }

    const preparationEvents = splitIndex > 0 ? session.slice(0, splitIndex) : [];
    const solveEvents = splitIndex > 0 ? session.slice(splitIndex) : session;
    const start = Math.max(rangeStart, solveEvents[0].start);
    const end = Math.min(rangeEnd, solveEvents.at(-1)!.end);
    const solvedStartLikely = preparationEvents.length >= Math.max(8, Math.floor(solveEvents.length * 0.18));
    const stages: VideoStage[] = [];

    if (solvedStartLikely) {
      stages.push({
        kind: 'scramble',
        start: Math.max(rangeStart, preparationEvents[0].start),
        end: preparationEvents.at(-1)!.end,
        eventIds: preparationEvents.map((event) => event.id),
      });
    }
    const inspectionStart = solvedStartLikely
      ? preparationEvents.at(-1)!.end
      : Math.max(rangeStart, preparationEvents[0]?.start ?? rangeStart);
    if (start - inspectionStart >= 0.25 || (!solvedStartLikely && preparationEvents.length)) {
      stages.push({
        kind: 'inspection',
        start: inspectionStart,
        end: start,
        eventIds: solvedStartLikely ? [] : preparationEvents.map((event) => event.id),
      });
    }
    stages.push({
      kind: 'solve',
      start,
      end,
      eventIds: solveEvents.map((event) => event.id),
    });

    return {
      id: index + 1,
      start,
      end,
      eventIds: solveEvents.map((event) => event.id),
      confidence: Math.round(Math.min(94, 56 + solveEvents.length * 0.38 + Math.min(14, selectedPause))),
      startState: solvedStartLikely
        ? 'solved-likely' as const
        : preparationEvents.length
          ? 'scrambled-likely' as const
          : 'unknown' as const,
      stages,
    };
  });

  return {
    windows,
    defaultWindowId: windows.at(-1)?.id ?? null,
    pauseThreshold: sessionPauseThreshold,
  };
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
  const handCanvas = document.createElement('canvas');
  handCanvas.width = portrait ? 384 : 512;
  handCanvas.height = portrait ? 512 : 384;
  const handContext = handCanvas.getContext('2d');

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
  let handTracker: Awaited<ReturnType<typeof createHandMotionTracker>> | null = null;
  let handTrackingMessage: string | undefined;
  let framesWithHands = 0;

  try {
    handTracker = await createHandMotionTracker();
  } catch {
    handTrackingMessage = 'Il modello mani non è stato caricato: questa analisi usa il solo cambiamento del cubo.';
  }

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
      let handMeasurement = {
        handMotion: 0,
        fingerMotion: 0,
        wristMotion: 0,
        handCount: 0,
        dominantHand: 'unknown' as HandSide,
        handDirection: 'mixed' as HandDirection,
      };
      if (handTracker && handContext) {
        try {
          handContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, handCanvas.width, handCanvas.height);
          handMeasurement = handTracker.sample(handCanvas, time * 1000);
          if (handMeasurement.handCount > 0) framesWithHands += 1;
        } catch {
          handTracker.close();
          handTracker = null;
          handTrackingMessage = 'Il tracciamento delle mani si è interrotto; il decoder ha continuato con le variazioni del cubo.';
        }
      }
      samples.push({
        time,
        difference: measurement.score,
        cubeDifference: measurement.score,
        coverage: measurement.coverage,
        centerBias: measurement.centerBias,
        ...handMeasurement,
      });
      previous = current;
      options.onProgress?.((index + 1) / sampleCount);
    }
  } finally {
    handTracker?.close();
    await waitForSeek(video, originalTime).catch(() => undefined);
    if (!wasPaused) await video.play().catch(() => undefined);
  }

  const fusedSamples = fuseMotionEvidence(samples);
  return {
    ...detectMotionEvents(fusedSamples, sampleInterval),
    sampleInterval,
    analyzedRegion: 'cube-focus',
    handTracking: {
      available: framesWithHands > 0,
      framesWithHands,
      totalFrames: sampleCount,
      message: handTrackingMessage,
    },
  };
}
