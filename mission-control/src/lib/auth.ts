import { NextAuthOptions } from "next-auth";
import GithubProvider from "next-auth/providers/github";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import clientPromise from "@/lib/mongodb";

// NextAuth config lives here (not in the route file) because Next 16 route
// handlers may only export HTTP method handlers — exporting `authOptions` from
// route.ts fails type generation.
export const authOptions: NextAuthOptions = {
  adapter: MongoDBAdapter(clientPromise),
  session: {
    strategy: "jwt",
  },
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
      authorization: { params: { scope: 'read:user user:email repo' } },
      // Auto-link a GitHub sign-in to an existing user with the same email.
      // Prevents the `OAuthAccountNotLinked` error ("sign in with a different
      // account") that occurs when a `users` record exists without a linked
      // `accounts` record. Safe here because GitHub is the only provider.
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    async session({ session, token }) {
      // @ts-ignore
      session.accessToken = token.accessToken;
      if (session.user && token.sub) {
        (session.user as any).id = token.sub;
      }
      return session;
    },
  },
};
