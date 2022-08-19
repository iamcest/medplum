import { getDateProperty } from '@medplum/core';
import { ClientApplication, Login } from '@medplum/fhirtypes';
import { Request, Response } from 'express';
import { URL } from 'url';
import { asyncWrap } from '../async';
import { getConfig } from '../config';
import { systemRepo } from '../fhir/repo';
import { logger } from '../logger';
import { MedplumIdTokenClaims, verifyJwt } from './keys';

/*
 * Handles the OAuth/OpenID Authorization Endpoint.
 * See: https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 */

/**
 * HTTP GET handler for /oauth2/authorize endpoint.
 */
export const authorizeGetHandler = asyncWrap(async (req: Request, res: Response) => {
  const validateResult = await validateAuthorizeRequest(req, res);
  if (!validateResult) {
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const redirectUrl = new URL(getConfig().appBaseUrl + 'oauth');
  requestUrl.searchParams.forEach((value: string, name: string) => redirectUrl.searchParams.set(name, value));
  res.redirect(redirectUrl.toString());
});

/**
 * Validates the OAuth/OpenID Authorization Endpoint configuration.
 * This is used for both GET and POST requests.
 * We currently only support query string parameters.
 * See: https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 */
async function validateAuthorizeRequest(req: Request, res: Response): Promise<boolean> {
  // First validate the client and the redirect URI.
  // If these are invalid, then show an error page.
  let client = undefined;
  try {
    client = await systemRepo.readResource<ClientApplication>('ClientApplication', req.query.client_id as string);
  } catch (err) {
    res.status(400).send('Client not found');
    return false;
  }

  if (client.redirectUri !== req.query.redirect_uri) {
    res.status(400).send('Incorrect redirect_uri');
    return false;
  }

  const state = req.query.state as string;

  // Then, validate all other parameters.
  // If these are invalid, redirect back to the redirect URI.
  const scope = req.query.scope as string | undefined;
  if (!scope) {
    sendErrorRedirect(res, client.redirectUri as string, 'invalid_request', state);
    return false;
  }

  const responseType = req.query.response_type;
  if (responseType !== 'code') {
    sendErrorRedirect(res, client.redirectUri as string, 'unsupported_response_type', state);
    return false;
  }

  const requestObject = req.query.request as string | undefined;
  if (requestObject) {
    sendErrorRedirect(res, client.redirectUri as string, 'request_not_supported', state);
    return false;
  }

  const codeChallenge = req.query.code_challenge;
  if (codeChallenge) {
    const codeChallengeMethod = req.query.code_challenge_method;
    if (!codeChallengeMethod) {
      sendErrorRedirect(res, client.redirectUri as string, 'invalid_request', state);
      return false;
    }
  }

  const existingLogin = await getExistingLogin(req);

  const prompt = req.query.prompt as string | undefined;
  if (prompt === 'none' && !existingLogin) {
    sendErrorRedirect(res, client.redirectUri as string, 'login_required', state);
    return false;
  }

  if (prompt !== 'login' && existingLogin) {
    await systemRepo.updateResource<Login>({
      ...existingLogin,
      nonce: req.query.nonce as string,
      granted: false,
    });

    const redirectUrl = new URL(req.query.redirect_uri as string);
    redirectUrl.searchParams.append('code', existingLogin?.code as string);
    redirectUrl.searchParams.append('state', state);
    res.redirect(redirectUrl.toString());
    return false;
  }

  return true;
}

/**
 * Tries to get an existing login for the current request.
 * @param req The HTTP request.
 * @returns Existing login if found; undefined otherwise.
 */
async function getExistingLogin(req: Request): Promise<Login | undefined> {
  const login = await getExistingLoginFromIdTokenHint(req);

  if (!login) {
    return undefined;
  }

  const authTime = getDateProperty(login.authTime) as Date;
  const age = (Date.now() - authTime.getTime()) / 1000;
  const maxAge = req.query.max_age ? parseInt(req.query.max_age as string) : 3600;
  if (age > maxAge) {
    return undefined;
  }

  return login;
}

/**
 * Tries to get an existing login based on the "id_token_hint" query string parameter.
 * @param req The HTTP request.
 * @param client The current client application.
 * @returns Existing login if found; undefined otherwise.
 */
async function getExistingLoginFromIdTokenHint(req: Request): Promise<Login | undefined> {
  const idTokenHint = req.query.id_token_hint as string | undefined;
  if (!idTokenHint) {
    return undefined;
  }

  let verifyResult;
  try {
    verifyResult = await verifyJwt(idTokenHint);
  } catch (err) {
    logger.debug('Error verifying id_token_hint', err);
    return undefined;
  }

  const claims = verifyResult.payload as MedplumIdTokenClaims;
  const existingLoginId = claims.login_id as string | undefined;
  if (!existingLoginId) {
    return undefined;
  }

  return systemRepo.readResource<Login>('Login', existingLoginId);
}

/**
 * Sends a redirect back to the client application with error codes and state.
 * @param res The response.
 * @param redirectUri The client redirect URI.  This URI may already have query string parameters.
 * @param error The OAuth/OpenID error code.
 * @param state The client state.
 */
function sendErrorRedirect(res: Response, redirectUri: string, error: string, state: string): void {
  const url = new URL(redirectUri);
  url.searchParams.append('error', error);
  url.searchParams.append('state', state);
  res.redirect(url.toString());
}
