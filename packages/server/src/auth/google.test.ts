import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'crypto';
import express from 'express';
import { pwnedPassword } from 'hibp';
import fetch from 'node-fetch';
import request from 'supertest';
import { initApp, shutdownApp } from '../app';
import { getConfig, loadTestConfig } from '../config';
import { systemRepo } from '../fhir/repo';
import { getUserByEmail } from '../oauth/utils';
import { setupPwnedPasswordMock, setupRecaptchaMock } from '../test.setup';
import { registerNew } from './register';

jest.mock('hibp');
jest.mock('node-fetch');

jest.mock('jose', () => {
  const original = jest.requireActual('jose');
  return {
    ...original,
    jwtVerify: jest.fn((credential: string) => {
      if (credential === 'invalid') {
        throw new Error('Verification failed');
      }
      return {
        // By convention for tests, return the credential as the email
        // Obviously in the real world the credential would be a JWT
        // And the Google Auth service returns the corresponding email
        payload: JSON.parse(credential),
      };
    }),
  };
});

const app = express();

describe('Google Auth', () => {
  beforeAll(async () => {
    const config = await loadTestConfig();
    await initApp(app, config);
  });

  afterAll(async () => {
    await shutdownApp();
  });

  beforeEach(() => {
    (SESv2Client as unknown as jest.Mock).mockClear();
    (SendEmailCommand as unknown as jest.Mock).mockClear();
    (fetch as unknown as jest.Mock).mockClear();
    (pwnedPassword as unknown as jest.Mock).mockClear();
    setupPwnedPasswordMock(pwnedPassword as unknown as jest.Mock, 0);
    setupRecaptchaMock(fetch as unknown as jest.Mock, true);
  });

  test('Missing client ID', async () => {
    const res = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: '',
        googleCredential: createCredential('Admin', 'Admin', 'admin@example.com'),
      });
    expect(res.status).toBe(400);
    expect(res.body.issue).toBeDefined();
    expect(res.body.issue[0].details.text).toBe('Missing googleClientId');
  });

  test('Invalid client ID', async () => {
    const res = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: '123',
        googleCredential: createCredential('Admin', 'Admin', 'admin@example.com'),
      });
    expect(res.status).toBe(400);
    expect(res.body.issue).toBeDefined();
    expect(res.body.issue[0].details.text).toBe('Invalid googleClientId');
  });

  test('Missing googleCredential', async () => {
    const res = await request(app).post('/auth/google').type('json').send({
      googleClientId: getConfig().googleClientId,
      googleCredential: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.issue).toBeDefined();
    expect(res.body.issue[0].details.text).toBe('Missing googleCredential');
  });

  test('Verification failed', async () => {
    const res = await request(app).post('/auth/google').type('json').send({
      googleClientId: getConfig().googleClientId,
      googleCredential: 'invalid',
    });
    expect(res.status).toBe(400);
    expect(res.body.issue).toBeDefined();
    expect(res.body.issue[0].details.text).toBe('Verification failed');
  });

  test('Success', async () => {
    const res = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: getConfig().googleClientId,
        googleCredential: createCredential('Admin', 'Admin', 'admin@example.com'),
      });
    expect(res.status).toBe(200);
    expect(res.body.code).toBeDefined();
  });

  test('Do not create user', async () => {
    const email = 'new-google-' + randomUUID() + '@example.com';
    const res = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: getConfig().googleClientId,
        googleCredential: createCredential('Test', 'Test', email),
      });
    expect(res.status).toBe(400);

    const user = await getUserByEmail(email, undefined);
    expect(user).toBeUndefined();
  });

  test('Create new user account', async () => {
    const email = 'new-google-' + randomUUID() + '@example.com';
    const res = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: getConfig().googleClientId,
        googleCredential: createCredential('Test', 'Test', email),
        createUser: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.login).toBeDefined();
    expect(res.body.code).toBeUndefined();

    const user = await getUserByEmail(email, undefined);
    expect(user).toBeDefined();
  });

  test('Require Google auth', async () => {
    const email = `google${randomUUID()}@example.com`;
    const password = 'password!@#';

    // Register and create a project
    const { project } = await registerNew({
      firstName: 'Google',
      lastName: 'Google',
      projectName: 'Require Google Auth',
      email,
      password,
    });

    // As a super admin, update the project to require Google auth
    await systemRepo.updateResource({
      ...project,
      features: ['google-auth-required'],
    });

    // Then try to login with Google auth
    // This should succeed
    const res2 = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: getConfig().googleClientId,
        googleCredential: createCredential('Test', 'Test', email),
      });
    expect(res2.status).toBe(200);
    expect(res2.body.code).toBeDefined();
  });

  test('Custom Google client', async () => {
    const email = `google-client${randomUUID()}@example.com`;
    const password = 'password!@#';
    const googleClientId = 'google-client-id-' + randomUUID();

    // Register and create a project
    const { project } = await registerNew({
      firstName: 'Google',
      lastName: 'Google',
      projectName: 'Require Google Auth',
      email,
      password,
    });

    // As a super admin, set the google client ID
    await systemRepo.updateResource({
      ...project,
      site: [
        {
          name: 'Test Site',
          domain: ['example.com'],
          googleClientId,
        },
      ],
    });

    // Try to login with the custom Google client
    // This should succeed
    const res2 = await request(app)
      .post('/auth/google')
      .type('json')
      .send({
        googleClientId: googleClientId,
        googleCredential: createCredential('Test', 'Test', email),
      });
    expect(res2.status).toBe(200);
    expect(res2.body.code).toBeDefined();
  });
});

function createCredential(firstName: string, lastName: string, email: string): string {
  return JSON.stringify({ given_name: firstName, family_name: lastName, email });
}
