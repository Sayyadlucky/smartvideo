import { Directive, ElementRef, Input, OnChanges, SimpleChanges } from '@angular/core';

@Directive({
  selector: '[appSrcObject]',
  standalone: true
})
export class SrcObjectDirective implements OnChanges {
  @Input('appSrcObject') srcObject: MediaStream | null | undefined;

  constructor(private el: ElementRef<HTMLMediaElement>) {}

  ngOnChanges(changes: SimpleChanges) {
    if ('srcObject' in changes) {
      const element = this.el.nativeElement;
      if (this.srcObject instanceof MediaStream) {
        element.srcObject = this.srcObject;
      } else {
        element.srcObject = null;
      }
    }
  }
}
