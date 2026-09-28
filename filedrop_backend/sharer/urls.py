from django.urls import path
from . import views

urlpatterns = [
    path('sessions/', views.create, name='create-session'),
    path('sessions/<uuid:room_id>/', views.session, name='session'),
]
