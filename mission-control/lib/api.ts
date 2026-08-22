export const API = process.env.NEXT_PUBLIC_RELAY_API || "http://127.0.0.1:3001";

export function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API}${path.startsWith("/") ? path : `/${path}`}`;
}
