let intentionalNavigation = false;

export const markIntentionalNavigation = (): void => {
  intentionalNavigation = true;
};

export const clearIntentionalNavigation = (): void => {
  intentionalNavigation = false;
};

export const isIntentionalNavigation = (): boolean => intentionalNavigation;
