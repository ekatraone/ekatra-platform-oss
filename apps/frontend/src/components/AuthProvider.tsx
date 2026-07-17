import { useEffect, useState, ReactNode, createContext, useContext } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ROUTES } from "@/lib/constants";

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export type UserRole = 'super_admin' | 'admin' | 'viewer';

export interface User {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  organizationId?: string;
}

interface AuthContextProps {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => void;
  isAuthenticated: boolean;
  hasRole: (roles: UserRole | UserRole[]) => boolean;
}

export const AuthContext = createContext<AuthContextProps>({
  user: null,
  loading: true,
  signIn: async () => false,
  signOut: () => {},
  isAuthenticated: false,
  hasRole: () => false,
});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

const STORAGE_KEY = "ekatra_auth";

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Restore session from localStorage; re-validate token with backend
    const restore = async () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          const token = parsed.token;
          if (token) {
            // Verify token is still valid
            const res = await fetch(`${API_URL}/api/auth/me`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
              const data = await res.json();
              setUser(data.user);
              // Keep token inApiClient
              localStorage.setItem('auth_token', token);
            } else {
              localStorage.removeItem(STORAGE_KEY);
              localStorage.removeItem('auth_token');
            }
          }
        }
      } catch (e) {
        console.error("Failed to restore session:", e);
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem('auth_token');
      }
      setLoading(false);
    };
    restore();
  }, []);

  const signIn = async (email: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      if (!data.success || !data.token) return false;

      setUser(data.user);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: data.token, user: data.user }));
      // ApiClient reads this key on every request
      localStorage.setItem('auth_token', data.token);
      return true;
    } catch (error) {
      console.error("Sign in failed:", error);
      return false;
    }
  };

  const signOut = () => {
    setUser(null);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('auth_token');
    navigate(ROUTES.LOGIN);
  };

  const hasRole = (roles: UserRole | UserRole[]): boolean => {
    if (!user) return false;
    const allowed = Array.isArray(roles) ? roles : [roles];
    // super_admin can do everything
    if (user.role === 'super_admin') return true;
    return allowed.includes(user.role as UserRole);
  };

  const value: AuthContextProps = {
    user,
    loading,
    signIn,
    signOut,
    isAuthenticated: !!user,
    hasRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) {
      navigate(ROUTES.LOGIN, { state: { from: location } });
    }
  }, [user, loading, navigate, location]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
};

/**
 * Gate a subtree to users who have at least one of the given roles.
 * super_admin always passes. Renders `fallback` (or null) if access denied.
 */
export const RequireRole = ({
  roles,
  children,
  fallback = null,
}: {
  roles: UserRole | UserRole[];
  children: ReactNode;
  fallback?: ReactNode;
}) => {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  return hasRole(roles) ? <>{children}</> : <>{fallback}</>;
};
