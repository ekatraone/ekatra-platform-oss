
import { useEffect, useState } from "react";
import Sidebar from "@/components/dashboard/Sidebar";
import UsersList from "@/components/dashboard/UsersList";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { apiClient } from "@/services/apiClient";
import { RequireRole } from "@/components/AuthProvider";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

// Map raw backend user → AppUser shape expected by UsersList
const toAppUser = (u: any, idx: number) => ({
  id: idx + 1, // UsersList uses id as number key; backend id stored in _backendId
  _backendId: u.id,
  name: u.name || u.email.split('@')[0],
  email: u.email,
  role: u.role,
  courses: 0,
  joined: u.created_at?.split('T')[0] || '',
  status: 'active' as const,
});

const Users = () => {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/api/users') as any;
      setUsers((res?.data || []).map(toAppUser));
    } catch (err: any) {
      toast({ title: "Error loading users", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); }, []);

  const addUser = async (data: any) => {
    await apiClient.post('/api/users', { email: data.email, name: data.name, role: data.role });
    toast({ title: "User invited", description: `${data.email} has been added.` });
    fetchUsers();
  };

  const updateUser = async (userId: number, updates: any) => {
    const backendId = users.find(u => u.id === userId)?._backendId;
    if (!backendId) return;
    await apiClient.put(`/api/users/${backendId}`, updates);
    toast({ title: "User updated" });
    fetchUsers();
  };

  const deleteUser = async (userId: number) => {
    const backendId = users.find(u => u.id === userId)?._backendId;
    if (!backendId) return;
    await apiClient.delete(`/api/users/${backendId}`);
    toast({ title: "User deleted" });
    setUsers(u => u.filter(x => x.id !== userId));
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto py-6 px-4 md:px-6">
          <header className="mb-6">
            <h1 className="text-2xl font-bold">User Management</h1>
            <p className="text-muted-foreground">
              Manage platform admins and viewers
            </p>
          </header>

          <RequireRole roles="admin" fallback={
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Admin Access Required</AlertTitle>
              <AlertDescription>You need admin or super_admin role to manage users.</AlertDescription>
            </Alert>
          }>
            {loading ? (
              <div className="flex justify-center items-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : (
              <UsersList
                users={users}
                onAddUser={addUser}
                onUpdateUser={updateUser}
                onDeleteUser={deleteUser}
              />
            )}
          </RequireRole>
        </div>
      </main>
    </div>
  );
};

export default Users;
