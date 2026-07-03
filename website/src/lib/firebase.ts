import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

const env = import.meta.env;

// Firebase web config. These keys are public by design (they identify the
// project, they are not secrets) — but reading them from env vars lets you
// point staging/prod at different Firebase projects. Values fall back to the
// default project so local dev works without a .env file.
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'AIzaSyCpttswRNbD4VRuR_vsQOQbF-o5LGufjLA',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'veloci-buy.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'veloci-buy',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? 'veloci-buy.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '442884983448',
  appId: env.VITE_FIREBASE_APP_ID ?? '1:442884983448:web:8a415ee3d5681e90bb1eed',
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID ?? 'G-ZZ5980H941',
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Initialize Providers
const googleProvider = new GoogleAuthProvider();

// Export sign-in functions
export const signInWithGoogle = () => {
  return signInWithPopup(auth, googleProvider);
};

export { auth };
