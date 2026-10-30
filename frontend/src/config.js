/**
 * search-comete - config.js
 * Build-time switches. The site runs fully static by default (galaxy.json +
 * in-browser search + live OpenAlex). Set VITE_USE_BACKEND=1 when the FastAPI +
 * Elasticsearch backend is deployed behind /api.
 */

export const USE_BACKEND = import.meta.env.VITE_USE_BACKEND === '1';
export const API_BASE    = '/api';
export const OPENALEX    = 'https://api.openalex.org';
