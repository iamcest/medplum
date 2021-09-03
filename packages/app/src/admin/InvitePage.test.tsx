import { MedplumClient } from '@medplum/core';
import { MedplumProvider } from '@medplum/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Switch } from 'react-router-dom';
import { InvitePage } from './InvitePage';

const mockRouter = {
  push: (path: string, state: any) => {
    console.log('Navigate to: ' + path + ' (state=' + JSON.stringify(state) + ')');
  },
  listen: () => (() => undefined) // Return mock "unlisten" handler
}

function mockFetch(url: string, options: any): Promise<any> {
  let result: any;

  if (options.method === 'GET' && url.endsWith('/admin/projects/123')) {
    result = {
      project: { id: '123', name: 'Project 123' },
      members: [
        { profile: 'Practitioner/456', name: 'Alice Smith' }
      ]
    };
  }

  const response: any = {
    request: {
      url,
      options
    },
    ...result
  };

  return Promise.resolve({
    json: () => Promise.resolve(response)
  });
}

const medplum = new MedplumClient({
  baseUrl: 'https://example.com/',
  clientId: 'my-client-id',
  fetch: mockFetch
});

const setup = (url: string) => {
  render(
    <MedplumProvider medplum={medplum} router={mockRouter}>
      <MemoryRouter initialEntries={[url]} initialIndex={0}>
        <Switch>
          <Route exact path="/admin/projects/:id/invite"><InvitePage /></Route>
        </Switch>
      </MemoryRouter>
    </MedplumProvider>
  );
};

describe('InvitePage', () => {

  test('Renders', async () => {
    setup('/admin/projects/123/invite');

    await act(async () => {
      await waitFor(() => screen.getByText('Invite'));
    });

    expect(screen.getByText('Invite')).not.toBeUndefined();
  });

  test('Submit success', async () => {
    setup('/admin/projects/123/invite');

    await act(async () => {
      await waitFor(() => screen.getByText('Invite'));
    });

    expect(screen.getByText('Invite')).not.toBeUndefined();

    await act(async () => {
      fireEvent.change(screen.getByTestId('firstName'), { target: { value: 'George' } });
      fireEvent.change(screen.getByTestId('lastName'), { target: { value: 'Washington' } });
      fireEvent.change(screen.getByTestId('email'), { target: { value: 'george@example.com' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Invite'));
    });

    expect(screen.getByTestId('success')).not.toBeUndefined();
  });

});