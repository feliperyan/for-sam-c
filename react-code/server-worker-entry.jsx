import React from 'react';
import { renderToReadableStream } from 'react-dom/server';

const App = () => {
  const name = typeof __INITIAL_DATA__ !== 'undefined'
    ? __INITIAL_DATA__.user
    : 'Stranger';

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '20px' }}>
      <h1>React in a Box (Dynamic Worker)</h1>
      <p>Hello, <strong>{name}</strong>!</p>
      <p>This HTML was server-rendered inside a Cloudflare Dynamic Worker.</p>
    </div>
  );
};

// renderToReadableStream returns a Web ReadableStream — the native format
// for Workers responses. No string buffering or Node stream APIs needed.
export default {
  async fetch(request) {
    const stream = await renderToReadableStream(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>React in a Box (Dynamic Worker)</title>
        </head>
        <body>
          <div id="root">
            <App />
          </div>
          {/* Rendered server-side by a Cloudflare Dynamic Worker */}
        </body>
      </html>
    );

    return new Response(stream, {
      headers: { "Content-Type": "text/html" },
    });
  },
};
