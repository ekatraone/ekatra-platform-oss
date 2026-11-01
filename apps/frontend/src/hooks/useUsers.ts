import { useState } from "react";
import { AppUser, UserValidation } from "@/lib/types/user";
import { useToast } from "@/components/ui/use-toast";
import { fetchUsersList, inviteUser, updateUserProfile, deleteUserAccount } from "@/services/userService";

export const useUsers = () => {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adminRequired, setAdminRequired] = useState(false);
  const { toast } = useToast();

  const handleServiceError = (action: string, error: unknown) => {
    console.error(`Error ${action}:`, error);
    
    // Check if error is admin-related
    if ((error as Error).message?.includes("admin") || 
        (error as any)?.code === "not_admin") {
      setAdminRequired(true);
    }
    
    toast({
      title: `Error ${action}`,
      description: (error as Error).message,
      variant: "destructive",
    });
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const usersList = await fetchUsersList();
      setUsers(usersList.map(user => ({
        ...user, name: user.name || user.email.split('@')[0],
        courses: 0, joined: user.created_at?.split('T')[0] || '', status: 'active',
      })));
      setAdminRequired(false); // Reset admin required flag if successful
    } catch (error) {
      handleServiceError("fetching users", error);
    } finally {
      setLoading(false);
    }
  };

  const addUser = async (newUser: Partial<UserValidation>) => {
    try {
      if (!newUser.email || !newUser.role) {
        throw new Error("Email and role are required");
      }
      
      await inviteUser(newUser.email, newUser.role);
      
      toast({
        title: "User invited",
        description: `An invitation has been sent to ${newUser.email}.`,
      });
      
      // Refresh the users list
      fetchUsers();
    } catch (error) {
      handleServiceError("inviting user", error);
    }
  };

  const updateUser = async (userId: string, updates: Partial<UserValidation>) => {
    try {
      await updateUserProfile(userId, updates);
      toast({
        title: "User updated",
        description: "User has been updated successfully.",
      });
      setUsers(currentUsers => 
        currentUsers.map(user => 
          user.id === userId 
            ? { 
                ...user, 
                name: updates.name || user.name,
                role: updates.role || user.role,
                status: updates.status || user.status
              } 
            : user
        )
      );
    } catch (error) {
      handleServiceError("updating user", error);
    }
  };

  const deleteUser = async (userId: string) => {
    try {
      await deleteUserAccount(userId);
      toast({
        title: "User deleted",
        description: "User has been deleted successfully.",
      });
      setUsers(users.filter(u => u.id !== userId));
    } catch (error) {
      handleServiceError("deleting user", error);
    }
  };

  return {
    users,
    loading,
    adminRequired,
    fetchUsers,
    addUser,
    updateUser,
    deleteUser
  };
};
