import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { listAdminUsers } from "../../../lib/admin-users.ts";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../lib/next/runtime.ts";
import { setDisabledAction } from "./actions.ts";
import { CreateStaffForm } from "./create-staff-form.tsx";
import { ResetAccessForm } from "./reset-form.tsx";

export const metadata: Metadata = { title: "Team | Admin Console" };

/** Owner only: admin accounts. */
export default async function TeamPage() {
  const admin = await requireAdmin({ permission: "admin_user.manage" });
  const users = await listAdminUsers((await getRuntime()).sql);
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="text-xs text-muted-foreground">Owner and Staff accounts. Every change is written to the audit log.</p>
      </div>
      <Card>
        <CardTitle className="text-base">Add a Staff account</CardTitle>
        <CardDescription>
          Share the temporary password in person or by phone. At the first sign-in they choose a new password and set up two-factor, within 72 hours.
        </CardDescription>
        <CreateStaffForm />
      </Card>
      <Card className="p-0 md:p-0">
        <Table aria-label="Admin accounts">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Two-factor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.userId}>
                <TableCell className="font-medium">{user.displayName}</TableCell>
                <TableCell className="font-mono text-xs">{user.email}</TableCell>
                <TableCell>{user.role === "owner" ? "Owner" : "Staff"}</TableCell>
                <TableCell>
                  {user.twoFactorEnabled ? `On (${String(user.recoveryCodesLeft)} codes left)` : user.setupExpired ? <Badge variant="warning">Setup expired</Badge> : "Not set up yet"}
                </TableCell>
                <TableCell>{user.disabled ? <Badge variant="destructive">Disabled</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
                <TableCell className="text-right">
                  {user.userId === admin.userId ? (
                    <span className="text-xs text-muted-foreground">You</span>
                  ) : (
                    <div className="flex flex-col items-end gap-2">
                      <form action={setDisabledAction}>
                        <input type="hidden" name="userId" value={user.userId} />
                        <input type="hidden" name="disabled" value={user.disabled ? "false" : "true"} />
                        <Button type="submit" variant={user.disabled ? "secondary" : "destructive"} size="sm">
                          {user.disabled ? "Enable" : "Disable"}
                        </Button>
                      </form>
                      {user.role === "staff" ? <ResetAccessForm userId={user.userId} name={user.displayName} /> : null}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
