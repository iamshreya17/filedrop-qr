import { api } from '../api/api';

export const MEMORY_LIMIT = 128 * 1024 * 1024;
const CHUNK = 16 * 1024;
const WINDOW = 256 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function gather(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Local connection discovery timed out. Try again.')), 15000);
    function finish(error) {
      clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', change);
      error ? reject(error) : resolve();
    }
    function change() { if (pc.iceGatheringState === 'complete') finish(); }
    pc.addEventListener('icegatheringstatechange', change);
  });
}

export function createTransfer(update) {
  if (!window.RTCPeerConnection) throw new Error('This browser does not support direct transfers. Try a current Chrome, Edge, Firefox, or Safari browser.');
  // Local host candidates only. No external STUN/TURN services or server relay.
  const pc = new RTCPeerConnection({ iceServers: [] });
  let channel, room, stopped = false, completed = false, acknowledged, rejectAck;
  let writer, chunks = [], received = 0, metadata, objectURL, ready = false;
  let connectionTimer, inactivityTimer;
  const abort = new AbortController();
  const emit = state => { if (!stopped) update(state); };
  const clearTimers = () => { clearTimeout(connectionTimer); clearTimeout(inactivityTimer); };
  function touch() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => fail(new Error('The other device stopped responding. Keep both pages open and create a new share.')), 120000);
  }
  function fail(error) {
    if (stopped || completed) return;
    emit({ phase: 'error', error: error.response?.data?.detail || error.message || 'The connection was interrupted. Create a new share and try again.' });
    stop();
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearTimers(); abort.abort();
    if (rejectAck) rejectAck(new Error('Transfer stopped.'));
    channel?.close(); pc.close(); chunks = [];
    if (writer) { writer.abort().catch(() => {}); writer = null; }
    if (objectURL) URL.revokeObjectURL(objectURL);
    if (room) api.delete(`/sessions/${room.id}/`, { headers: { 'X-Sender-Token': room.sender_token } }).catch(() => {});
  }
  function connectTimeout() {
    connectionTimer = setTimeout(() => fail(new Error('Could not connect directly. Check that both devices are on the same WiFi and client isolation is disabled. Some networks or browsers block local peer discovery.')), 30000);
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') fail(new Error('The direct connection failed. Check your WiFi and try a new share.'));
    if (pc.connectionState === 'disconnected') touch();
  };
  function setup(dc) {
    channel = dc; channel.binaryType = 'arraybuffer';
    channel.onclose = () => fail(new Error('The other device closed the connection. Start a new share.'));
    channel.onerror = () => fail(new Error('Transfer connection interrupted. Please try again.'));
    channel.onopen = () => { clearTimeout(connectionTimer); };
  }
  async function sendFile(file) {
    emit({ phase: 'transferring', progress: 0 });
    let offset = 0;
    while (offset < file.size && !stopped) {
      const end = Math.min(offset + WINDOW, file.size);
      // Wait for the receiver to write each window before reading the next.
      const ack = new Promise((resolve, reject) => { acknowledged = resolve; rejectAck = reject; });
      // Mark handled immediately if cancellation occurs while reading file slices.
      ack.catch(() => {});
      while (offset < end && !stopped) {
        const data = await file.slice(offset, Math.min(offset + CHUNK, end)).arrayBuffer();
        if (stopped) return;
        channel.send(data); offset += data.byteLength;
      }
      channel.send(JSON.stringify({ type: 'checkpoint', offset })); touch();
      await ack; clearTimeout(inactivityTimer);
      emit({ progress: Math.round(offset / file.size * 100) });
    }
    if (!stopped) { channel.send(JSON.stringify({ type: 'end' })); touch(); }
  }
  async function send(file) {
    try {
      setup(pc.createDataChannel('file', { ordered: true }));
      let sending = false;
      channel.onopen = () => {
        clearTimeout(connectionTimer);
        channel.send(JSON.stringify({ type: 'metadata', name: file.name, size: file.size }));
        emit({ phase: 'waiting-download' });
      };
      channel.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'ready' && !sending) { sending = true; sendFile(file).catch(fail); }
          if (message.type === 'ack') { acknowledged?.(); acknowledged = null; rejectAck = null; }
          if (message.type === 'done') {
            completed = true; clearTimers(); emit({ phase: 'complete', progress: 100 });
            if (room) api.delete(`/sessions/${room.id}/`, { headers: { 'X-Sender-Token': room.sender_token } }).catch(() => {});
          }
          if (message.type === 'error') fail(new Error(message.detail || 'The receiver could not save this file.'));
        } catch (error) { fail(error); }
      };
      emit({ phase: 'preparing' });
      await pc.setLocalDescription(await pc.createOffer()); await gather(pc);
      if (stopped) return;
      const { data } = await api.post('/sessions/', { offer: pc.localDescription.toJSON(), origin: window.location.origin }, { signal: abort.signal });
      room = data;
      if (stopped) { api.delete(`/sessions/${room.id}/`, { headers: { 'X-Sender-Token': room.sender_token } }).catch(() => {}); return; }
      emit({ phase: 'waiting', room });
      const deadline = Date.now() + data.expires_in * 1000;
      while (!stopped && Date.now() < deadline) {
        const response = await api.get(`/sessions/${room.id}/`, { headers: { 'X-Sender-Token': room.sender_token }, signal: abort.signal });
        if (response.data.answer) {
          emit({ phase: 'connecting' }); connectTimeout();
          await pc.setRemoteDescription(response.data.answer); return;
        }
        await delay(1800);
      }
      if (!stopped) throw new Error('This QR code expired after 15 minutes. Create a new share.');
    } catch (error) { fail(error); }
  }
  async function receive(id) {
    try {
      emit({ phase: 'connecting' });
      const { data } = await api.get(`/sessions/${id}/`, { signal: abort.signal });
      if (stopped) return;
      pc.ondatachannel = event => {
        setup(event.channel);
        // Serial processing ensures async disk writes finish before acknowledging.
        let chain = Promise.resolve();
        channel.onmessage = event => {
          chain = chain.then(async () => {
            if (stopped) return;
            if (typeof event.data !== 'string') {
              if (!ready || !metadata || received + event.data.byteLength > metadata.size) throw new Error('Invalid file data received.');
              touch();
              if (writer) await writer.write(event.data); else chunks.push(event.data);
              received += event.data.byteLength;
              emit({ progress: metadata.size ? Math.round(received / metadata.size * 100) : 100 });
              return;
            }
            const message = JSON.parse(event.data);
            if (message.type === 'metadata') {
              if (metadata || typeof message.name !== 'string' || !Number.isSafeInteger(message.size) || message.size < 0) throw new Error('Invalid file details.');
              metadata = { name: message.name.slice(0, 255), size: message.size };
              emit({ phase: 'offered', file: metadata });
            } else if (message.type === 'checkpoint') {
              if (!ready || received !== message.offset) throw new Error('Transfer size mismatch. Please try again.');
              channel.send(JSON.stringify({ type: 'ack' }));
            } else if (message.type === 'end') {
              if (!ready || received !== metadata.size) throw new Error('The file arrived incomplete. Please try again.');
              if (writer) { await writer.close(); writer = null; }
              else {
                objectURL = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' })); chunks = [];
              }
              channel.send(JSON.stringify({ type: 'done' })); completed = true; clearTimers();
              emit({ phase: 'complete', progress: 100, downloadURL: objectURL });
            }
          }).catch(error => {
            try { channel.send(JSON.stringify({ type: 'error', detail: 'The receiver could not save the file.' })); } catch { /* closed */ }
            fail(error);
          });
        };
      };
      await pc.setRemoteDescription(data.offer);
      await pc.setLocalDescription(await pc.createAnswer()); await gather(pc);
      if (stopped) return;
      await api.post(`/sessions/${id}/`, { answer: pc.localDescription.toJSON() }, { signal: abort.signal });
      if (channel?.readyState !== 'open') connectTimeout();
    } catch (error) { fail(error); }
  }
  async function accept() {
    if (ready || !metadata || stopped) return;
    try {
      if (window.isSecureContext && window.showSaveFilePicker) {
        // Must be invoked directly from the receiver's button click.
        const handle = await window.showSaveFilePicker({ suggestedName: metadata.name });
        writer = await handle.createWritable();
        if (stopped) { await writer.abort(); writer = null; return; }
      } else if (metadata.size > MEMORY_LIMIT) {
        emit({ error: 'This browser can receive up to 128 MB. For larger files, use Chrome or Edge with this app served over trusted HTTPS so it can save directly to disk.' }); return;
      }
      ready = true; emit({ phase: 'transferring', progress: 0, error: '' });
      channel.send(JSON.stringify({ type: 'ready' })); touch();
    } catch (error) { if (error.name !== 'AbortError') fail(error); }
  }
  return { send, receive, accept, stop };
}
