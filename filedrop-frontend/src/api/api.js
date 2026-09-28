import axios from 'axios';
const host = window.location.hostname.replace(/^\[|\]$/g, '');
const origin = `${window.location.protocol}//${host.includes(':') ? `[${host}]` : host}:8000/api`;
export const api = axios.create({ baseURL: (import.meta.env.VITE_API_BASE || origin).replace(/\/$/, '') });
export const errorMessage = error => error.response?.data?.detail || 'Could not reach FileDrop. Check that the backend is running and both devices are on the same network.';
export function formatSize(bytes) {
  if (!bytes) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}
