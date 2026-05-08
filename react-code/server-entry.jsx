import React from 'react';
import { renderToString } from 'react-dom/server';

const App = () => {
  // __INITIAL_DATA__ is injected into the NodeVM sandbox by the container
  const name = typeof __INITIAL_DATA__ !== 'undefined'
    ? __INITIAL_DATA__.user
    : 'Stranger';

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '20px' }}>
      <h1>React in a Box</h1>
      <p>Hello, <strong>{name}</strong>!</p>
      <p>This HTML was server-rendered inside a Cloudflare Container using NodeVM.</p>
    </div>
  );
};

module.exports = renderToString(<App />);
