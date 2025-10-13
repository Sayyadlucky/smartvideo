from django.shortcuts import redirect
from django.views.generic import View

class RedirectToAngular(View):
    def get(self, request, *args, **kwargs):
        return redirect('http://localhost:4200')
