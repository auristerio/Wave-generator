/* =====================================================================
   Acoustic Wave Builder — script.js
   Everything runs client-side: no build step, no dependencies.

   Sections in this file:
     1. Setup & element references
     2. Building and wiring the 5 signal cards
     3. Waveform synthesis (sine / square / triangle / noise)
     4. FFT (frequency analysis)
     5. Canvas plotting
     6. Generate / update pipeline
     7. Exporting plots (PNG/JPG) and audio (WAV) + playback
   ===================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1. Setup & element references
     ------------------------------------------------------------------ */

  const MAX_SIGNALS = 5;

  const signalListEl   = document.getElementById('signal-list');
  const durationInput  = document.getElementById('duration');
  const sampleRateSel  = document.getElementById('sampleRate');
  const timeWindowInput = document.getElementById('timeWindow');
  const maxFreqInput   = document.getElementById('maxFreq');
  const generateBtn    = document.getElementById('generateBtn');

  const timeCanvas = document.getElementById('timeCanvas');
  const freqCanvas = document.getElementById('freqCanvas');

  const playBtn        = document.getElementById('playBtn');
  const stopBtn         = document.getElementById('stopBtn');
  const downloadWavBtn = document.getElementById('downloadWavBtn');
  const statusMsg       = document.getElementById('statusMsg');

  // State kept between renders
  let hasGenerated  = false;   // becomes true after the first "Generate" click
  let lastSamples   = null;    // Float32Array of the most recently generated wave
  let lastSampleRate = 44100;
  let audioCtx      = null;
  let currentSource = null;    // currently-playing AudioBufferSourceNode
  let updateTimer   = null;    // debounce handle for live updates

  /* ------------------------------------------------------------------
     2. Building and wiring the 5 signal cards
     ------------------------------------------------------------------ */

  function createSignalCard(index) {
    const card = document.createElement('div');
    card.className = 'signal-card';
    card.dataset.index = String(index);

    card.innerHTML = `
      <div class="signal-card-header">
        <label class="toggle">
          <input type="checkbox" class="sig-enabled" ${index === 0 ? 'checked' : ''}>
          <span>Signal ${index + 1}</span>
        </label>
        <select class="sig-type">
          <option value="sine">Sine</option>
          <option value="square">Square</option>
          <option value="triangle">Triangle</option>
          <option value="noise">Noise</option>
        </select>
      </div>

      <div class="signal-controls">

        <div class="control freq-control">
          <label>Frequency (Hz)</label>
          <div class="paired-input">
            <input type="range" class="sig-freq-range" min="20" max="5000" value="440" step="1">
            <input type="number" class="sig-freq-number" min="1" max="20000" value="440" step="1">
          </div>
        </div>

        <div class="control amp-control">
          <label>Intensity</label>
          <div class="paired-input">
            <input type="range" class="sig-amp-range" min="0" max="1" value="0.5" step="0.01">
            <input type="number" class="sig-amp-number" min="0" max="1" value="0.5" step="0.01">
          </div>
        </div>

        <div class="control phase-control">
          <label>Phase (&deg;)</label>
          <div class="paired-input">
            <input type="range" class="sig-phase-range" min="0" max="360" value="0" step="1">
            <input type="number" class="sig-phase-number" min="0" max="360" value="0" step="1">
          </div>
        </div>

        <div class="control duty-control" hidden>
          <label>Duty cycle (%)</label>
          <div class="paired-input">
            <input type="range" class="sig-duty-range" min="1" max="99" value="50" step="1">
            <input type="number" class="sig-duty-number" min="1" max="99" value="50" step="1">
          </div>
        </div>

        <div class="control noise-control" hidden>
          <label>Noise color</label>
          <select class="sig-noise-color">
            <option value="white">White</option>
            <option value="pink">Pink</option>
            <option value="brown">Brown</option>
          </select>
        </div>

      </div>
    `;

    return card;
  }

  // Keeps a range input and a number input showing the same value.
  function syncPair(rangeEl, numberEl, onChange) {
    rangeEl.addEventListener('input', () => {
      numberEl.value = rangeEl.value;
      onChange();
    });
    numberEl.addEventListener('input', () => {
      const min = parseFloat(rangeEl.min);
      const max = parseFloat(rangeEl.max);
      const raw = parseFloat(numberEl.value);
      // The number field may legitimately go beyond the slider's range
      // (e.g. frequency above 5000 Hz); only the slider's handle is clamped.
      rangeEl.value = isNaN(raw) ? rangeEl.value : Math.min(Math.max(raw, min), max);
      onChange();
    });
  }

  function wireSignalCard(card) {
    const typeSelect      = card.querySelector('.sig-type');
    const enabledCheckbox = card.querySelector('.sig-enabled');
    const noiseColorSel   = card.querySelector('.sig-noise-color');

    const freqRange  = card.querySelector('.sig-freq-range');
    const freqNumber = card.querySelector('.sig-freq-number');
    const ampRange   = card.querySelector('.sig-amp-range');
    const ampNumber  = card.querySelector('.sig-amp-number');
    const phaseRange  = card.querySelector('.sig-phase-range');
    const phaseNumber = card.querySelector('.sig-phase-number');
    const dutyRange  = card.querySelector('.sig-duty-range');
    const dutyNumber = card.querySelector('.sig-duty-number');

    const freqControl  = card.querySelector('.freq-control');
    const phaseControl = card.querySelector('.phase-control');
    const dutyControl  = card.querySelector('.duty-control');
    const noiseControl = card.querySelector('.noise-control');

    // Show only the controls relevant to the selected wave type.
    function updateVisibleControls() {
      const type = typeSelect.value;
      freqControl.hidden  = type === 'noise';
      phaseControl.hidden = type === 'noise';
      dutyControl.hidden  = type !== 'square';
      noiseControl.hidden = type !== 'noise';
    }

    typeSelect.addEventListener('change', () => {
      updateVisibleControls();
      triggerLiveUpdate();
    });
    enabledCheckbox.addEventListener('change', triggerLiveUpdate);
    noiseColorSel.addEventListener('change', triggerLiveUpdate);

    syncPair(freqRange, freqNumber, triggerLiveUpdate);
    syncPair(ampRange, ampNumber, triggerLiveUpdate);
    syncPair(phaseRange, phaseNumber, triggerLiveUpdate);
    syncPair(dutyRange, dutyNumber, triggerLiveUpdate);

    updateVisibleControls();
  }

  for (let i = 0; i < MAX_SIGNALS; i++) {
    signalListEl.appendChild(createSignalCard(i));
  }
  document.querySelectorAll('.signal-card').forEach(wireSignalCard);

  function readSignalConfigs() {
    const cards = document.querySelectorAll('.signal-card');
    const configs = [];
    cards.forEach((card) => {
      configs.push({
        enabled:    card.querySelector('.sig-enabled').checked,
        type:       card.querySelector('.sig-type').value,
        freq:       parseFloat(card.querySelector('.sig-freq-number').value) || 0,
        amp:        parseFloat(card.querySelector('.sig-amp-number').value) || 0,
        phaseDeg:   parseFloat(card.querySelector('.sig-phase-number').value) || 0,
        duty:       parseFloat(card.querySelector('.sig-duty-number').value) || 50,
        noiseColor: card.querySelector('.sig-noise-color').value,
      });
    });
    return configs;
  }

  /* ------------------------------------------------------------------
     3. Waveform synthesis
     ------------------------------------------------------------------ */

  function sampleSine(t, freq, amp, phaseRad) {
    return amp * Math.sin(2 * Math.PI * freq * t + phaseRad);
  }

  function sampleSquare(t, freq, amp, phaseRad, dutyFraction) {
    const cycle = (((freq * t) + phaseRad / (2 * Math.PI)) % 1 + 1) % 1;
    return cycle < dutyFraction ? amp : -amp;
  }

  function sampleTriangle(t, freq, amp, phaseRad) {
    const cycle = (((freq * t) + phaseRad / (2 * Math.PI)) % 1 + 1) % 1;
    const shape = cycle < 0.5 ? (cycle * 4 - 1) : (3 - cycle * 4);
    return amp * shape;
  }

  function generateWhiteNoise(length, amp) {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = amp * (Math.random() * 2 - 1);
    return out;
  }

  // Voss-McCartney algorithm: a cheap, good-enough approximation of pink noise (~ -3dB/octave).
  function generatePinkNoise(length, amp) {
    const rows = 16;
    const generators = new Float32Array(rows);
    for (let r = 0; r < rows; r++) generators[r] = Math.random() * 2 - 1;

    let runningSum = 0;
    for (let r = 0; r < rows; r++) runningSum += generators[r];

    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      // Update the generator whose index equals the trailing-zero count of (i+1).
      let n = i + 1;
      let idx = 0;
      while ((n & 1) === 0 && idx < rows - 1) {
        n >>= 1;
        idx++;
      }
      runningSum -= generators[idx];
      generators[idx] = Math.random() * 2 - 1;
      runningSum += generators[idx];
      out[i] = runningSum / rows;
    }

    normalizeInPlace(out, amp);
    return out;
  }

  // Brown/red noise: an integrated (random-walk) white noise, leaked slightly so it can't drift away.
  function generateBrownNoise(length, amp) {
    const out = new Float32Array(length);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) * 0.999;
      out[i] = last;
    }
    normalizeInPlace(out, amp);
    return out;
  }

  function normalizeInPlace(arr, amp) {
    let peak = 0;
    for (let i = 0; i < arr.length; i++) peak = Math.max(peak, Math.abs(arr[i]));
    const scale = peak > 0 ? amp / peak : 0;
    for (let i = 0; i < arr.length; i++) arr[i] *= scale;
  }

  function buildSignalSamples(config, length, sampleRate) {
    if (config.type === 'noise') {
      if (config.noiseColor === 'pink') return generatePinkNoise(length, config.amp);
      if (config.noiseColor === 'brown') return generateBrownNoise(length, config.amp);
      return generateWhiteNoise(length, config.amp);
    }

    const out = new Float32Array(length);
    const phaseRad = (config.phaseDeg * Math.PI) / 180;
    const dutyFraction = config.duty / 100;

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      if (config.type === 'square') out[i] = sampleSquare(t, config.freq, config.amp, phaseRad, dutyFraction);
      else if (config.type === 'triangle') out[i] = sampleTriangle(t, config.freq, config.amp, phaseRad);
      else out[i] = sampleSine(t, config.freq, config.amp, phaseRad); // default: sine
    }
    return out;
  }

  function buildCombinedWave(configs, duration, sampleRate) {
    const length = Math.max(1, Math.round(duration * sampleRate));
    const combined = new Float32Array(length);

    configs.filter((c) => c.enabled).forEach((config) => {
      const samples = buildSignalSamples(config, length, sampleRate);
      for (let i = 0; i < length; i++) combined[i] += samples[i];
    });

    // Only rescale if the mix actually clips — this keeps a single quiet
    // signal quiet, rather than always normalizing to full volume.
    let peak = 0;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(combined[i]));
    if (peak > 1) {
      for (let i = 0; i < length; i++) combined[i] /= peak;
    }

    return combined;
  }

  /* ------------------------------------------------------------------
     4. FFT (frequency analysis)
     ------------------------------------------------------------------ */

  function nextPowerOfTwo(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  // Iterative in-place radix-2 Cooley-Tukey FFT. `re`/`im` must have a power-of-two length.
  function fftInPlace(re, im) {
    const n = re.length;

    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k];
          const uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;

          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe;
          im[i + k + len / 2] = uIm - vIm;

          const nextRe = curRe * wRe - curIm * wIm;
          const nextIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
          curIm = nextIm;
        }
      }
    }
  }

  function computeSpectrum(samples, sampleRate) {
    const fftSize = Math.min(nextPowerOfTwo(samples.length), 16384);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const n = Math.min(samples.length, fftSize);

    // Hann window to reduce spectral leakage from the finite sample block.
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re[i] = samples[i] * w;
    }

    fftInPlace(re, im);

    const bins = fftSize / 2;
    const magnitudes = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
      magnitudes[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / (fftSize / 2);
    }

    return { magnitudes, freqResolution: sampleRate / fftSize };
  }

  /* ------------------------------------------------------------------
     5. Canvas plotting
     ------------------------------------------------------------------ */

  function clearCanvas(ctx, canvas) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawFrame(ctx, canvas, margin) {
    ctx.strokeStyle = '#b9cfe3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, canvas.height - margin.bottom);
    ctx.lineTo(canvas.width - margin.right, canvas.height - margin.bottom);
    ctx.stroke();
  }

  function drawTimePlot(samples, sampleRate, windowSeconds) {
    const canvas = timeCanvas;
    const ctx = canvas.getContext('2d');
    clearCanvas(ctx, canvas);

    const margin = { left: 55, right: 20, top: 24, bottom: 34 };
    const plotWidth = canvas.width - margin.left - margin.right;
    const plotHeight = canvas.height - margin.top - margin.bottom;

    const sampleCount = Math.min(samples.length, Math.max(2, Math.round(windowSeconds * sampleRate)));

    // Horizontal gridlines with amplitude labels.
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = '#e3ecf4';
    ctx.fillStyle = '#5b7186';
    [-1, -0.5, 0, 0.5, 1].forEach((level) => {
      const y = margin.top + plotHeight * (1 - (level + 1) / 2);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(canvas.width - margin.right, y);
      ctx.stroke();
      ctx.fillText(level.toFixed(1), 6, y + 4);
    });

    // Waveform.
    ctx.strokeStyle = '#2f6fb0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < sampleCount; i++) {
      const x = margin.left + (i / (sampleCount - 1)) * plotWidth;
      const y = margin.top + plotHeight * (1 - (samples[i] + 1) / 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // X-axis time labels.
    ctx.fillStyle = '#5b7186';
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const timeVal = (t / ticks) * (sampleCount / sampleRate);
      const x = margin.left + (t / ticks) * plotWidth;
      ctx.fillText(timeVal.toFixed(3) + 's', Math.max(margin.left, x - 18), canvas.height - margin.bottom + 16);
    }

    drawFrame(ctx, canvas, margin);
    ctx.fillStyle = '#1c2b3a';
    ctx.fillText('Amplitude vs. time', margin.left, 14);
  }

  function drawFreqPlot(magnitudes, freqResolution, maxFreq) {
    const canvas = freqCanvas;
    const ctx = canvas.getContext('2d');
    clearCanvas(ctx, canvas);

    const margin = { left: 55, right: 20, top: 24, bottom: 34 };
    const plotWidth = canvas.width - margin.left - margin.right;
    const plotHeight = canvas.height - margin.top - margin.bottom;

    const maxBin = Math.max(1, Math.min(magnitudes.length - 1, Math.floor(maxFreq / freqResolution)));
    let peakMag = 0;
    for (let i = 0; i <= maxBin; i++) peakMag = Math.max(peakMag, magnitudes[i]);
    if (peakMag === 0) peakMag = 1;

    // Horizontal gridlines with magnitude labels.
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = '#e3ecf4';
    ctx.fillStyle = '#5b7186';
    const levels = 4;
    for (let l = 0; l <= levels; l++) {
      const y = margin.top + plotHeight * (1 - l / levels);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(canvas.width - margin.right, y);
      ctx.stroke();
      ctx.fillText(((peakMag * l) / levels).toFixed(2), 6, y + 4);
    }

    // Spectrum curve.
    ctx.strokeStyle = '#2f6fb0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= maxBin; i++) {
      const x = margin.left + (i / maxBin) * plotWidth;
      const y = margin.top + plotHeight * (1 - magnitudes[i] / peakMag);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // X-axis frequency labels.
    ctx.fillStyle = '#5b7186';
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const freqVal = (t / ticks) * maxFreq;
      const x = margin.left + (t / ticks) * plotWidth;
      ctx.fillText(Math.round(freqVal) + 'Hz', Math.max(margin.left, x - 18), canvas.height - margin.bottom + 16);
    }

    drawFrame(ctx, canvas, margin);
    ctx.fillStyle = '#1c2b3a';
    ctx.fillText('Magnitude vs. frequency', margin.left, 14);
  }

  /* ------------------------------------------------------------------
     6. Generate / update pipeline
     ------------------------------------------------------------------ */

  function generateAndPlot() {
    const duration = Math.max(0.05, parseFloat(durationInput.value) || 1);
    const sampleRate = parseInt(sampleRateSel.value, 10);
    const windowSeconds = Math.min(duration, Math.max(0.001, parseFloat(timeWindowInput.value) || 0.05));
    const maxFreq = Math.min(sampleRate / 2, Math.max(50, parseFloat(maxFreqInput.value) || 2000));

    const configs = readSignalConfigs();
    const anyEnabled = configs.some((c) => c.enabled);

    const samples = buildCombinedWave(configs, duration, sampleRate);
    lastSamples = samples;
    lastSampleRate = sampleRate;

    drawTimePlot(samples, sampleRate, windowSeconds);
    const { magnitudes, freqResolution } = computeSpectrum(samples, sampleRate);
    drawFreqPlot(magnitudes, freqResolution, maxFreq);

    hasGenerated = true;
    playBtn.disabled = !anyEnabled;
    downloadWavBtn.disabled = !anyEnabled;
    statusMsg.textContent = anyEnabled
      ? `Wave generated: ${duration.toFixed(2)}s at ${sampleRate}Hz.`
      : 'All signals are off — the wave is silent.';
  }

  function triggerLiveUpdate() {
    if (!hasGenerated) return; // wait for the first explicit "Generate" click
    clearTimeout(updateTimer);
    updateTimer = setTimeout(generateAndPlot, 120);
  }

  generateBtn.addEventListener('click', generateAndPlot);

  [durationInput, timeWindowInput, maxFreqInput].forEach((el) => {
    el.addEventListener('input', triggerLiveUpdate);
  });
  sampleRateSel.addEventListener('change', triggerLiveUpdate);

  /* ------------------------------------------------------------------
     7. Exporting plots (PNG/JPG) and audio (WAV) + playback
     ------------------------------------------------------------------ */

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.querySelectorAll('.download-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const canvas = document.getElementById(btn.dataset.canvas);
      const format = btn.dataset.format; // 'png' or 'jpeg'
      const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const extension = format === 'jpeg' ? 'jpg' : 'png';
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${btn.dataset.canvas}.${extension}`);
      }, mime, 0.95);
    });
  });

  function encodeWav(samples, sampleRate) {
    const bytesPerSample = 2; // 16-bit PCM
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);        // fmt chunk size
    view.setUint16(20, 1, true);         // PCM format
    view.setUint16(22, 1, true);         // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
    view.setUint16(32, bytesPerSample, true);              // block align
    view.setUint16(34, 16, true);        // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += bytesPerSample;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  downloadWavBtn.addEventListener('click', () => {
    if (!lastSamples) return;
    downloadBlob(encodeWav(lastSamples, lastSampleRate), 'acoustic-wave.wav');
  });

  function getAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  playBtn.addEventListener('click', () => {
    if (!lastSamples) return;
    const ctx = getAudioContext();
    const buffer = ctx.createBuffer(1, lastSamples.length, lastSampleRate);
    buffer.copyToChannel(lastSamples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { stopBtn.disabled = true; };
    source.start();

    currentSource = source;
    stopBtn.disabled = false;
  });

  stopBtn.addEventListener('click', () => {
    if (currentSource) {
      currentSource.stop();
      currentSource = null;
    }
    stopBtn.disabled = true;
  });

})();
