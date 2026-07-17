
import { createContext, useContext } from "react";

// Simple user type (replaces Supabase types)
export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  role?: string;
}

export interface Session {
  access_token: string;
  user: AuthUser;
}

export interface AuthContextProps {
  session: Session | null;
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextProps>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
});

export const useAuthContext = () => useContext(AuthContext);
