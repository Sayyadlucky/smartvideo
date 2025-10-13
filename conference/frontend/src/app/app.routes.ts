import { Routes } from '@angular/router';
import { Dashboard } from './dashboard/dashboard'
export const routes: Routes = [
  {
    path: 'video-call',
    component: Dashboard
  },
  {
    path: '',
    redirectTo: 'video-call',
    pathMatch: 'full'
  }

  ];
