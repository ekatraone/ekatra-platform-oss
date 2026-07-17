// User types for the application

export type UserRole = 'admin' | 'instructor' | 'learner';

export interface UserValidation {
  name: string;
  email: string;
  role: UserRole;
  status?: 'active' | 'inactive';
}

export interface UserUpdatePayload {
  name?: string;
  email?: string;
  role?: UserRole;
  status?: 'active' | 'inactive';
}

export interface Profile {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

export interface UserRoleRecord {
  user_id: string;
  role: UserRole;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role?: UserRole;
}

// Define an AppUser interface for the UI representation
export interface AppUser {
  id: number;
  name: string;
  email: string;
  role: string;
  courses: number;
  joined: string;
  status: "active" | "inactive";
}
