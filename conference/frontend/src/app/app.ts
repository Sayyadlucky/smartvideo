import { Component, signal } from '@angular/core';
import { Dashboard } from './dashboard/dashboard';
import { HttpClientModule } from '@angular/common/http';

@Component({
  selector: 'app-root',
  imports: [Dashboard,
    HttpClientModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
}
)
export class App {
  protected readonly title = signal('frontend');
}
