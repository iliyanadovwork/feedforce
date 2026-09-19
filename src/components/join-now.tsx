'use client';

import { createContext, useContext } from 'react';

// Landing CTAs open the auth overlay owned by FeedforceLanding: "Join Now" / "Signup" open the
// signup form, the header "Login" opens the login form. A context keeps the section components
// free of prop-drilling.
export interface AuthCtas {
  join: () => void;
  login: () => void;
}

export const JoinNowContext = createContext<AuthCtas>({ join: () => {}, login: () => {} });
export const useJoinNow = () => useContext(JoinNowContext).join;
export const useLogin = () => useContext(JoinNowContext).login;
