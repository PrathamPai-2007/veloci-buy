import assert from 'node:assert/strict';
import test from 'node:test';

// Exact replica of the theme resolution logic from App.tsx
function getInitialTheme(mockLocalStorage: any) {
  try {
    const saved = mockLocalStorage.getItem('theme');
    return saved === 'dark' || saved === 'light' ? saved : 'light';
  } catch {
    return 'light';
  }
}

// Exact replica of the theme toggle logic from App.tsx
function toggleTheme(prevTheme: 'light' | 'dark', mockLocalStorage: any) {
  const next = prevTheme === 'light' ? 'dark' : 'light';
  try {
    mockLocalStorage.setItem('theme', next);
  } catch {
    // Fallback if third-party storage access is disabled or blocked
  }
  return next;
}

test('Theme initialization fallback when localStorage is normal', () => {
  const store: Record<string, string> = { theme: 'dark' };
  const mockLocalStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, val: string) => {
      store[key] = val;
    },
  };

  const initial = getInitialTheme(mockLocalStorage);
  assert.equal(initial, 'dark', 'Should retrieve saved theme under normal conditions');
});

test('Theme initialization fallback when localStorage.getItem throws SecurityError', () => {
  const mockLocalStorage = {
    getItem: () => {
      throw new Error('SecurityError: The operation is insecure.');
    },
    setItem: () => {},
  };

  const initial = getInitialTheme(mockLocalStorage);
  assert.equal(initial, 'light', 'Should fall back to light theme if getItem throws SecurityError');
});

test('Theme toggle success when localStorage is normal', () => {
  const store: Record<string, string> = {};
  const mockLocalStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, val: string) => {
      store[key] = val;
    },
  };

  const nextTheme = toggleTheme('light', mockLocalStorage);
  assert.equal(nextTheme, 'dark', 'Should toggle from light to dark');
  assert.equal(store.theme, 'dark', 'Should persist the toggled theme to localStorage');
});

test('Theme toggle success when localStorage.setItem throws QuotaExceededError', () => {
  const mockLocalStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError: The quota has been exceeded.');
    },
  };

  // Toggle should succeed in returning the next state value even if persistence fails
  const nextTheme = toggleTheme('light', mockLocalStorage);
  assert.equal(nextTheme, 'dark', 'Should toggle from light to dark');
});

test('Theme initialization and toggling when accessing localStorage itself throws', () => {
  // Simulates browser environment where reading window.localStorage throws directly
  const brokenEnv = {
    get localStorage(): any {
      throw new Error('SecurityError: Access to localStorage is denied.');
    },
  };

  // Run initial theme resolution within the throwing context
  let initialTheme: string;
  try {
    const saved = brokenEnv.localStorage.getItem('theme');
    initialTheme = saved === 'dark' || saved === 'light' ? saved : 'light';
  } catch {
    initialTheme = 'light';
  }
  assert.equal(
    initialTheme,
    'light',
    'Should safely fall back to light theme if global localStorage access itself throws'
  );

  // Run toggle within the throwing context
  let nextTheme: string;
  try {
    const next = (initialTheme === 'light' ? 'dark' : 'light') as 'light' | 'dark';
    brokenEnv.localStorage.setItem('theme', next);
    nextTheme = next;
  } catch {
    nextTheme = initialTheme === 'light' ? 'dark' : 'light';
  }
  assert.equal(
    nextTheme,
    'dark',
    'Should toggle and return next theme even if global localStorage access itself throws'
  );
});
