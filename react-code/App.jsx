import React from 'react';
import { createRoot } from 'react-dom/client';

const App = () => {
  // Accessing the data we'll inject via the VM globals
  const name = window.__INITIAL_DATA__?.user || "Stranger";

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '20px' }}>
      <h1>React in a Box 📦</h1>
      <p>Hello, <strong>{name}</strong>!</p>
      <button onClick={() => console.log("Clicking doesn't do much in SSR!")}>
        Click Me
      </button>
    </div>
  );
};

// This targets the <div id="root"> we'll create in JSDOM
const container = document.getElementById('root');
const root = createRoot(container);
root.render(<App />);

