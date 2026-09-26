import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Authentication & Authorization middleware for control/admin endpoints.
 * Requires HTTP header:
 * - 'x-api-key': <admin_api_key>
 * OR
 * - 'Authorization': 'Bearer <admin_api_key>'
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminApiKey = process.env.TRADEGATEKEEPER_ADMIN_API_KEY;

  if (!adminApiKey) {
    // If no key configured in environment, fail-closed for security
    console.error('[AuthMiddleware] TRADEGATEKEEPER_ADMIN_API_KEY is not set in environment!');
    res.status(500).json({ error: 'SERVER_CONFIG_ERROR', message: 'Admin authentication is not configured.' });
    return;
  }

  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  const authHeader = req.headers['authorization'] as string | undefined;

  let providedToken: string | undefined;

  if (apiKeyHeader) {
    providedToken = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.substring(7).trim();
  }

  if (!providedToken) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required. Please provide valid API key via x-api-key or Authorization header.',
    });
    return;
  }

  // Use timing-safe comparison to prevent timing attacks
  const tokenBuffer = Buffer.from(providedToken);
  const keyBuffer = Buffer.from(adminApiKey);

  if (tokenBuffer.length !== keyBuffer.length || !crypto.timingSafeEqual(tokenBuffer, keyBuffer)) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Invalid API key or unauthorized request.',
    });
    return;
  }

  next();
}
